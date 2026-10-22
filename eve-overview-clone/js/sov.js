// ===== 主权规划：主权中心升级件、电力、劳动力与试剂 =====
// 数据：sov-data.json（build_sov.mjs 由最新 SDE 生成）——升级件耗电 / 劳动力 / 燃料，各星系恒星电力，各行星殖民地资源。
// 规则（Equinox 起，含 Legion 改动）：
//   - 电力 = 恒星电力 + 装了轨道天钩的气体 / 风暴 / 等离子行星；电力只能本星系使用
//   - 劳动力 = 装了天钩的温和 / 贫瘠 / 海洋行星；可在同一联盟的星系间导出 / 导入，途经星系设为「中转」；每个星系最多从 3 个星系导入
//   - 试剂：冰体行星天钩产超离子冰、熔岩行星天钩产岩浆气，要手动运到主权中心燃料仓；升级件上线时一次性消耗启动燃料，之后按小时消耗
//   - 同一互斥组只能装一个（如同种矿物的勘探阵列 1–3、电力监控部门与劳动力机械工具、四种稳定发生器）
//   - 升级件按优先级依次分配电力和劳动力，资源不够的进入低电量（本页按「放不下就跳过，继续给后面的」模拟）
//   - 电力监控部门 / 劳动力机械工具产出的电力 / 劳动力只供优先级更低的升级件使用；机械工具产出的劳动力不能导出
// ESI（宁静服，2026-05 起的新接口，需 esi-structures.read_corporation.v1 与军团职位）：
//   /corporations/{id}/structures/sovereignty-hubs[/{hub}]：升级件与上线状态、电力 / 劳动力、燃料仓、劳动力运输设置
//   /corporations/{id}/structures/skyhooks[/{id}]：天钩所在行星、是否在产出、试剂库存
//   /sovereignty/systems：各星系主权联盟与军事 / 工业 / 战略等级（国服没有，用旧的 /sovereignty/map/ 只取联盟）
import { SERVER, IS_TQ } from './server.js?v=s3';

let ctx;   // esc, formatNumber, formatISK, showToast, store, fetchESI, resolveNames, openMapSystem, getEsiToken, hasEsiToken, tokenInfo, hasScopeGroup, scopeNeededHtml, getHubPrices, closeDrawer
const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s);
const num = (n) => ctx.formatNumber(Math.round(n || 0));

const STORE_KEY = 'eve-sov-plan';
const ESI_NEW = 'https://esi.evetech.net';
const COMPAT = '2026-08-18';
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const ICE = 81144, GAS = 81143;
// 行星类型 → [名称, 资源]
const PLANET = {
  11: ['温和', 'wf'], 2014: ['海洋', 'wf'], 2016: ['贫瘠', 'wf'],
  13: ['气体', 'power'], 2017: ['风暴', 'power'], 2063: ['等离子', 'power'],
  12: ['冰体', ICE], 2015: ['熔岩', GAS]
};
const RES_NAME = { power: '电力', wf: '劳动力' };
const MODE_NAME = { '': '不运输', export: '导出', import: '导入', transit: '中转' };
const STATE_NAME = { Online: '在线', Offline: '离线', Low: '低电量', Pending: '等待中', Unspecified: '未知' };
const SKYHOOK_STATE = { ShieldVulnerable: '正常', ArmorReinforced: '装甲增强', ArmorVulnerable: '装甲可攻击', HullReinforced: '结构增强', HullVulnerable: '结构可攻击', Unspecified: '未知' };

const D = { loading: null, sov: null, sys: new Map(), regions: new Map(), consts: new Map(), up: new Map(), owners: null, ownersLoading: null, prices: null };
const S = { tab: 'plan', cur: 0, query: '', pick: null, esi: null, esiLoading: false };
let P = { list: [], sys: {} };

export function initSov(context) {
  ctx = context;
  P = ctx.store.getJSON(STORE_KEY, null) || { list: [], sys: {} };
}
const save = () => ctx.store.setJSON(STORE_KEY, P);

// ---------- 数据 ----------
function loadData() {
  if (!D.loading) {
    D.loading = Promise.all([
      fetch('sov-data.json?v=1').then((r) => { if (!r.ok) throw new Error('sov-data.json ' + r.status); return r.json(); }),
      fetch(SERVER.mapData).then((r) => { if (!r.ok) throw new Error('星图数据 ' + r.status); return r.json(); })
    ]).then(([sov, map]) => {
      D.sov = sov;
      for (const u of sov.upgrades) {
        const [id, name, en, group, excl, power, wf, powerProd, wfProd, fuel, upkeep, startup, desc] = u;
        D.up.set(id, { id, name, en, group, excl, power, wf, powerProd, wfProd, fuel, upkeep, startup, desc });
      }
      for (const r of map.regions) D.regions.set(r[0], r[1]);
      for (const c of map.constellations) D.consts.set(c[0], { name: c[1], region: c[2] });
      const index = map.systems.map((s) => {
        const sys = { id: s[0], name: s[1], sec: s[5], region: s[6], cons: s[7], nbr: [], res: sov.systems[s[0]] };
        D.sys.set(sys.id, sys);
        return sys;
      });
      for (const [a, b] of map.gates) { index[a].nbr.push(index[b].id); index[b].nbr.push(index[a].id); }
      // 规划里可能有当前服务器星图没有的星系（如曙光服）：去掉
      P.list = P.list.filter((id) => D.sys.get(id)?.res);
    }).catch((e) => { D.loading = null; throw e; });
  }
  return D.loading;
}

// 新版 ESI（带兼容日期，宁静服）
async function esiNew(path, auth) {
  const headers = { 'Accept-Language': 'zh' };
  if (auth) headers.Authorization = 'Bearer ' + (await ctx.getEsiToken()).access_token;
  const res = await fetch(`${ESI_NEW}${path}${path.includes('?') ? '&' : '?'}compatibility_date=${COMPAT}`, { headers });
  if (!res.ok) {
    const error = new Error('ESI ' + res.status);
    error.status = res.status;
    error.esiError = await res.json().then((d) => d.error || '', () => '');
    throw error;
  }
  return res.json();
}

// 各星系主权：Map(星系 → { alliance, corp, faction, dev: [军事, 工业, 战略], capital })
function loadOwners() {
  if (!D.ownersLoading) {
    D.ownersLoading = (async () => {
      const owners = new Map();
      if (IS_TQ) {
        const d = await esiNew('/sovereignty/systems');
        for (const s of d.solar_systems || []) {
          const a = s.claim?.alliance, f = s.claim?.faction;
          if (a) owners.set(s.solar_system_id, { alliance: a.alliance_id, corp: a.corporation_id, capital: a.is_capital_system,
            dev: [a.development?.military_level, a.development?.industrial_level, a.development?.strategic_level], adm: a.development?.activity_defense_multiplier });
          else if (f) owners.set(s.solar_system_id, { faction: f.faction_id });
        }
      } else {
        for (const s of await ctx.fetchESI('/sovereignty/map/')) {
          if (s.alliance_id) owners.set(s.system_id, { alliance: s.alliance_id, corp: s.corporation_id });
          else if (s.faction_id) owners.set(s.system_id, { faction: s.faction_id });
        }
      }
      const ids = [...new Set([...owners.values()].map((o) => o.alliance || o.faction).filter(Boolean))];
      const r = await ctx.resolveNames(ids).catch(() => ({ names: new Map() }));
      D.names = r.names;
      D.owners = owners;
      return owners;
    })().catch((e) => { D.ownersLoading = null; throw e; });
  }
  return D.ownersLoading;
}
const ownerName = (o) => (o && (D.names?.get(o.alliance || o.faction) || String(o.alliance || o.faction))) || '';

// ---------- 规划 ----------
function entry(id) {
  return (P.sys[id] ||= { off: [], ups: [], mode: '', to: 0, amount: 0 });
}
function addSystems(ids) {
  let n = 0;
  for (const id of ids) {
    if (!D.sys.get(id)?.res || P.list.includes(id)) continue;
    P.list.push(id); entry(id); n++;
  }
  sortList();
  save();
  return n;
}
function sortList() {
  const key = (id) => { const s = D.sys.get(id); return [D.regions.get(s.region) || '', D.consts.get(s.cons)?.name || '', s.name]; };
  P.list.sort((a, b) => { const x = key(a), y = key(b); return x[0].localeCompare(y[0], 'zh') || x[1].localeCompare(y[1], 'zh') || x[2].localeCompare(y[2], 'en'); });
}
function removeSystem(id) {
  P.list = P.list.filter((x) => x !== id);
  delete P.sys[id];
  for (const e of Object.values(P.sys)) if (e.to === id) { e.to = 0; }
  if (S.cur === id) S.cur = P.list[0] || 0;
  save();
}

// 星系资源（按天钩开关）
function resources(id) {
  const s = D.sys.get(id), e = entry(id);
  const off = new Set(e.off);
  const out = { star: s.res[0], power: s.res[0], wf: 0, [ICE]: 0, [GAS]: 0, planets: [] };
  for (const [pid, type, idx, value] of s.res[1]) {
    const kind = PLANET[type]?.[1];
    const on = !off.has(pid);
    out.planets.push({ pid, type, idx, value, kind, on });
    if (on && kind) out[kind] += value;
  }
  return out;
}

// 劳动力运输路线：从 from 沿星门到 to，途经的星系都要在规划里且设为中转
function route(from, to) {
  if (!to || !P.list.includes(to)) return null;
  const prev = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const n of D.sys.get(cur).nbr) {
      if (prev.has(n)) continue;
      if (n !== to && !(P.list.includes(n) && P.sys[n]?.mode === 'transit')) continue;
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let c = to; c; c = prev.get(c)) path.unshift(c);
  return path;
}

// 整个规划的模拟结果
function simulate() {
  const R = new Map();
  for (const id of P.list) R.set(id, { res: resources(id), imp: 0, exp: 0, flows: [], warn: [] });
  // 劳动力运输
  const incoming = new Map();
  for (const id of P.list) {
    const e = P.sys[id], r = R.get(id);
    if (e.mode !== 'export') continue;
    const flow = { from: id, to: e.to, amount: Math.max(0, Math.min(Number(e.amount) || 0, r.res.wf)), want: Number(e.amount) || 0, path: null, ok: false, why: '' };
    if (!e.to) flow.why = '没有选目的星系';
    else if (!P.list.includes(e.to)) flow.why = '目的星系不在规划里';
    else if (P.sys[e.to].mode !== 'import') flow.why = '目的星系没有设为导入';
    else if (!(flow.path = route(id, e.to))) flow.why = '没有连通的路线（途经星系都要在规划里并设为中转）';
    else flow.ok = true;
    if (flow.ok) {
      const list = incoming.get(e.to) || [];
      if (list.length >= 3) { flow.ok = false; flow.why = '目的星系已有 3 个导入来源'; }
      else { list.push(flow); incoming.set(e.to, list); }
    }
    if (flow.want > r.res.wf) r.warn.push(`导出 ${num(flow.want)} 超过本星系天钩劳动力 ${num(r.res.wf)}，按 ${num(flow.amount)} 计`);
    if (!flow.ok) r.warn.push('劳动力导出无效：' + flow.why);
    r.out = flow;
    if (flow.ok) {
      r.exp = flow.amount;
      R.get(e.to).imp += flow.amount;
      for (const mid of flow.path.slice(1, -1)) R.get(mid).flows.push(flow);
    }
  }
  for (const [to, list] of incoming) R.get(to).sources = list;
  // 升级件按优先级分配
  for (const id of P.list) {
    const e = P.sys[id], r = R.get(id);
    let power = r.res.power, wf = r.res.wf + r.imp - r.exp, bonusP = 0, bonusW = 0;
    r.powerTotal = power; r.wfTotal = wf;
    r.usedP = 0; r.usedW = 0;
    r.fuel = { [ICE]: 0, [GAS]: 0 }; r.startup = { [ICE]: 0, [GAS]: 0 };
    r.ups = e.ups.map(([tid, on]) => {
      const u = D.up.get(tid);
      if (!u) return { tid, on, state: 'gone' };
      if (!on) return { u, on, state: 'off' };
      // 先用受限的产出（只给低优先级用），再用基础资源
      const useP = Math.min(bonusP, u.power), useW = Math.min(bonusW, u.wf);
      if (u.power - useP > power || u.wf - useW > wf) return { u, on, state: 'low' };
      bonusP -= useP; bonusW -= useW; power -= u.power - useP; wf -= u.wf - useW;
      bonusP += u.powerProd; bonusW += u.wfProd;
      r.powerTotal += u.powerProd; r.wfTotal += u.wfProd;
      r.usedP += u.power; r.usedW += u.wf;
      if (u.fuel) { r.fuel[u.fuel] += u.upkeep; r.startup[u.fuel] += u.startup; }
      return { u, on, state: 'ok' };
    });
    r.freeP = power + bonusP; r.freeW = wf + bonusW;
    if (e.mode === 'import' && !(r.sources || []).length) r.warn.push('设为导入，但没有有效的导出星系指向这里');
    if (e.mode === 'transit' && !r.flows.length) r.warn.push('设为中转，但没有劳动力经过');
    if (r.ups.some((x) => x.state === 'low')) r.warn.push('有升级件资源不足（低电量）');
  }
  return R;
}

// ---------- 页面 ----------
export async function showSov(hash) {
  const main = $('sovMain');
  const m = /^#sov(?:\/(overview|esi|sys\/(\d+)))?/.exec(hash || '');
  if (m?.[1] === 'overview') S.tab = 'overview';
  else if (m?.[1] === 'esi') S.tab = 'esi';
  else if (m) { S.tab = 'plan'; if (m[2]) S.cur = Number(m[2]); }
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `<section class="pi-page sov-page">
      <div class="pi-head"><h2 id="sovTitle">主权规划</h2><span class="toolbar-spacer"></span><span class="text-muted sov-src" id="sovSrc"></span></div>
      <div id="sovBody"><div class="empty-state"><p>加载中…</p></div></div></section>`;
    bindEvents($('sovView'));
  }
  try { await loadData(); } catch (error) { $('sovBody').innerHTML = `<div class="empty-state"><p>数据加载失败：${esc(error.message)}</p></div>`; return; }
  $('sovSrc').textContent = `数据：SDE ${D.sov.sdeDate.slice(0, 10)}（build ${D.sov.sdeBuild}）`;
  if (!S.cur || !P.list.includes(S.cur)) S.cur = P.list[0] || 0;
  render();
}

function setHash() {
  const h = S.tab === 'plan' ? (S.cur ? '#sov/sys/' + S.cur : '#sov') : '#sov/' + S.tab;
  if (location.hash !== h) history.replaceState(null, '', location.pathname + h);
}

function render() {
  setHash();
  const body = $('sovBody');
  const R = simulate();
  renderSide(R);
  $('sovTitle').textContent = { plan: '主权规划', overview: '规划总览', esi: '我的主权设施' }[S.tab];
  if (S.tab === 'esi') { renderEsi(body); return; }
  if (S.tab === 'overview') body.innerHTML = overviewHtml(R);
  else body.innerHTML = P.list.length ? detailHtml(R) : introHtml();
}

// 侧边栏：页面切换、搜索结果（加入规划）、规划里的星系
function renderSide(R) {
  const side = $('sovSide');
  const nav = [['plan', '规划', P.list.length], ['overview', '总览', ''], ['esi', '我的主权设施', '']].map(([k, name, n]) =>
    `<button class="ind-side-item${S.tab === k ? ' active' : ''}" data-sov-tab="${k}"><span>${name}</span>${n !== '' ? `<small>${n}</small>` : ''}</button>`).join('');
  side.innerHTML = `<div class="ind-side-nav">${nav}</div>
    <div class="sov-pick" id="sovPick" hidden></div>
    <div class="ind-side-section sov-side-list">${P.list.length ? listHtml(R) : '<p class="ind-side-empty">在上面搜索星系、星座或星域，加入规划。</p>'}</div>`;
  const input = $('sovSearch');
  if (input && input.value !== S.query) input.value = S.query;
  renderPick();
}

function introHtml() {
  return `<div class="pi-card sov-intro"><h3>怎么用</h3><ol>
    <li>在左侧搜索星系、星座或星域加入规划（星座 / 星域可只加某个联盟的主权星系）</li>
    <li>每个星系勾选哪些行星装了轨道天钩：气体 / 风暴 / 等离子行星供电，温和 / 贫瘠 / 海洋行星供劳动力，冰体 / 熔岩行星产燃料试剂</li>
    <li>按优先级添加升级件，本页模拟哪些能上线、还剩多少电力和劳动力、每小时烧多少燃料</li>
    <li>劳动力不够的星系可以从别的星系导入：导出星系选目的地和数量，路上经过的星系设为中转</li>
    <li>有军团职位的话，在「我的主权设施」用 ESI 读出实际配置，一键导入成规划再调整</li></ol>
    <p class="text-muted">规划保存在本机浏览器，可在「总览」导出 / 导入。</p></div>`;
}

function searchHits(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const count = new Map();
  for (const s of D.sys.values()) if (s.res) { count.set('c' + s.cons, (count.get('c' + s.cons) || 0) + 1); count.set('r' + s.region, (count.get('r' + s.region) || 0) + 1); }
  for (const [id, name] of D.regions) if (count.get('r' + id) && name.toLowerCase().includes(q)) hits.push({ kind: 'region', id, name, n: count.get('r' + id) });
  for (const [id, c] of D.consts) if (count.get('c' + id) && c.name.toLowerCase().includes(q)) hits.push({ kind: 'cons', id, name: c.name, sub: D.regions.get(c.region), n: count.get('c' + id) });
  for (const s of D.sys.values()) if (s.res && s.name.toLowerCase().includes(q)) hits.push({ kind: 'sys', id: s.id, name: s.name, sub: `${D.consts.get(s.cons)?.name} · ${D.regions.get(s.region)}` });
  const rank = (h) => (h.name.toLowerCase() === q ? 0 : h.name.toLowerCase().startsWith(q) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b)).slice(0, 14);
}
function areaSystems(kind, id) {
  return [...D.sys.values()].filter((s) => s.res && (kind === 'region' ? s.region === id : s.cons === id)).map((s) => s.id);
}
function renderPick() {
  const box = $('sovPick');
  if (!box) return;
  if (S.pick) {
    const ids = areaSystems(S.pick.kind, S.pick.id);
    const owners = D.owners;
    const tally = new Map();
    if (owners) for (const id of ids) { const o = owners.get(id); const k = o ? (o.alliance ? 'a' + o.alliance : 'f' + o.faction) : 'none'; tally.set(k, (tally.get(k) || 0) + 1); }
    const opts = [...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
      const label = k === 'none' ? '无主' : (D.names?.get(Number(k.slice(1))) || k.slice(1)) + (k[0] === 'f' ? '（NPC 势力）' : '');
      return `<option value="${k}">${esc(label)}（${n}）</option>`;
    }).join('');
    box.hidden = false;
    box.innerHTML = `<div class="sov-pick-area"><b>${esc(S.pick.name)}</b><span class="text-muted">${S.pick.kind === 'region' ? '星域' : '星座'} · ${ids.length} 个可建主权星系</span>
      <label>按主权筛选<select class="input" id="sovPickOwner"><option value="">全部</option>${owners ? opts : '<option disabled>读取主权中…</option>'}</select></label>
      <div class="sov-pick-btns"><button class="btn btn-primary" data-sov-pick-add>加入规划</button><button class="btn btn-ghost" data-sov-pick-cancel>取消</button></div></div>`;
    if (!owners) loadOwners().then(() => { if (S.pick) renderPick(); }).catch(() => {});
    return;
  }
  const hits = searchHits(S.query);
  box.hidden = !S.query.trim();
  if (S.query.trim() && !hits.length) { box.innerHTML = '<p class="ind-side-empty">没有可建主权中心的星系 / 星座 / 星域匹配</p>'; return; }
  box.innerHTML = hits.map((h) => `<button class="sov-hit" data-sov-hit="${h.kind}:${h.id}"><span class="sov-kind">${{ region: '星域', cons: '星座', sys: '星系' }[h.kind]}</span><b>${esc(h.name)}</b>
    <span class="text-muted">${h.kind === 'sys' ? esc(h.sub) : `${h.sub ? esc(h.sub) + ' · ' : ''}${h.n} 个星系`}</span>${h.kind === 'sys' && P.list.includes(h.id) ? '<span class="sov-tag">已在规划</span>' : ''}</button>`).join('');
}

function statusOf(r) {
  if (r.warn.length) return 'warn';
  return 'ok';
}
function listHtml(R) {
  let html = '', lastRegion = 0;
  for (const id of P.list) {
    const s = D.sys.get(id), r = R.get(id), e = P.sys[id];
    if (s.region !== lastRegion) { html += `<h4>${esc(D.regions.get(s.region))}</h4>`; lastRegion = s.region; }
    const running = r.ups.filter((x) => x.state === 'ok').length;
    html += `<button class="sov-list-item${S.tab === 'plan' && id === S.cur ? ' active' : ''}" data-sov-sys="${id}">
      <span class="sov-dot ${statusOf(r)}"></span><b>${esc(s.name)}</b>${e.mode ? `<span class="sov-mode m-${e.mode}">${MODE_NAME[e.mode]}</span>` : ''}
      <span class="sov-mini">${running}/${e.ups.length} 件 · 电 ${num(r.freeP)} · 劳 ${num(r.freeW)}</span></button>`;
  }
  return `<div class="sov-list-head"><span>规划中的星系 ${P.list.length}</span><button class="btn btn-ghost btn-sm" data-sov-clear>清空</button></div>${html}`;
}

function bar(used, total) {
  const pct = total > 0 ? Math.min(100, used / total * 100) : (used > 0 ? 100 : 0);
  return `<div class="sov-bar${used > total ? ' over' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}
const reagentName = (id) => D.sov.reagents[id]?.name || id;

function detailHtml(R) {
  const id = S.cur, s = D.sys.get(id), e = P.sys[id], r = R.get(id);
  if (!s) return '';
  const o = D.owners?.get(id);
  if (!D.owners) loadOwners().then(() => { if (S.tab === 'plan' && S.cur === id) render(); }).catch(() => {});
  const devs = o?.dev ? `<span class="sov-dev" title="军事 / 工业 / 战略等级（0–5）">军事 ${o.dev[0] ?? '–'} · 工业 ${o.dev[1] ?? '–'} · 战略 ${o.dev[2] ?? '–'}${o.capital ? ' · 首都' : ''}</span>` : '';
  const net = (k) => r.res[k] - r.fuel[k];
  return `<div class="sov-sys-head"><h3><a href="#map=${id}" data-sov-map="${id}">${esc(s.name)}</a></h3>
      <span class="text-muted">${esc(D.consts.get(s.cons)?.name)} · ${esc(D.regions.get(s.region))} · ${s.sec.toFixed(1)}</span>
      ${o ? `<span class="sov-owner">${esc(ownerName(o))}</span>${devs}` : (D.owners ? '<span class="text-muted">无主</span>' : '')}
      <span class="toolbar-spacer"></span><button class="btn btn-ghost btn-sm" data-sov-remove="${id}">移出规划</button></div>
    <div class="pi-stats sov-stats">
      <div><span>电力 已用 / 总量</span><b>${num(r.usedP)} / ${num(r.powerTotal)}</b>${bar(r.usedP, r.powerTotal)}</div>
      <div><span>劳动力 已用 / 总量</span><b>${num(r.usedW)} / ${num(r.wfTotal)}</b>${bar(r.usedW, r.wfTotal)}</div>
      <div><span>劳动力 导入 / 导出</span><b>${num(r.imp)} / ${num(r.exp)}</b></div>
      <div><span>${reagentName(ICE)} 每小时 产出 − 消耗</span><b class="${net(ICE) < 0 ? 'down' : 'up'}">${net(ICE) > 0 ? '+' : ''}${num(net(ICE))}</b></div>
      <div><span>${reagentName(GAS)} 每小时 产出 − 消耗</span><b class="${net(GAS) < 0 ? 'down' : 'up'}">${net(GAS) > 0 ? '+' : ''}${num(net(GAS))}</b></div>
    </div>
    ${r.warn.length ? `<div class="sov-warn">${r.warn.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
    <div class="sov-grid">
      ${upgradesCard(id, e, r)}
      ${transportCard(id, e, r, R)}
      ${planetsCard(id, s, r)}
    </div>`;
}

// 升级件消耗 / 产出简述（电力监控部门耗劳动力产电，劳动力机械工具耗电产劳动力）
function upCost(u) {
  const parts = [];
  if (u.power) parts.push(`电 ${num(u.power)}`);
  if (u.wf) parts.push(`劳 ${num(u.wf)}`);
  if (u.powerProd) parts.push(`产电 +${num(u.powerProd)}`);
  if (u.wfProd) parts.push(`产劳 +${num(u.wfProd)}`);
  if (u.fuel) parts.push(`${reagentName(u.fuel)} ${num(u.upkeep)}/时`);
  return parts.join(' · ');
}

function upgradesCard(id, e, r) {
  const used = new Set(e.ups.map(([tid]) => D.up.get(tid)?.excl));
  const groups = new Map();
  for (const u of D.up.values()) { if (!groups.has(u.group)) groups.set(u.group, []); groups.get(u.group).push(u); }
  const opts = [...groups].map(([g, list]) => `<optgroup label="${esc(D.sov.groups[g] || g)}">${list.map((u) =>
    `<option value="${u.id}"${used.has(u.excl) ? ' disabled' : ''}>${esc(u.name)}　${upCost(u)}${used.has(u.excl) ? '（同组已装）' : ''}</option>`).join('')}</optgroup>`).join('');
  const STATE = { ok: ['运行', 'ok'], low: ['资源不足', 'low'], off: ['已关闭', 'off'], gone: ['已删除的升级件', 'off'] };
  const fuelCell = (u) => u.fuel ? `${num(u.upkeep)} ${esc(reagentName(u.fuel))}` : '—';
  const rows = r.ups.map((x, i) => {
    const u = x.u;
    const [label, cls] = STATE[x.state];
    return `<tr><td class="num">${i + 1}</td><td title="${esc(u?.desc || '')}">${esc(u?.name || '类型 ' + x.tid)}</td>
      <td class="num">${u ? (u.powerProd ? `<span class="up">+${num(u.powerProd)}</span>` : num(u.power)) : ''}</td>
      <td class="num">${u ? (u.wfProd ? `<span class="up">+${num(u.wfProd)}</span>` : num(u.wf)) : ''}</td>
      <td class="num">${u ? fuelCell(u) : ''}</td><td class="num">${u?.startup ? num(u.startup) : '—'}</td>
      <td><span class="sov-state s-${cls}">${label}</span></td>
      <td><div class="sov-actions"><button data-sov-up="up:${i}" title="提高优先级"${i ? '' : ' disabled'}>↑</button><button data-sov-up="down:${i}" title="降低优先级"${i < r.ups.length - 1 ? '' : ' disabled'}>↓</button>
        <button data-sov-up="toggle:${i}" title="${x.on ? '关闭' : '开启'}">${x.on ? '关' : '开'}</button><button data-sov-up="del:${i}" title="移除">✕</button></div></td></tr>`;
  }).join('');
  return `<div class="pi-card sov-card-ups"><div class="pi-card-head"><h3>升级件</h3><span class="text-muted">按优先级从上到下分配资源；启动燃料为上线时一次性消耗</span></div>
    ${rows ? `<div class="pi-table-wrap"><table class="pi-table sov-table"><thead><tr><th class="num">#</th><th>升级件</th><th class="num">电力</th><th class="num">劳动力</th><th class="num">燃料 / 小时</th><th class="num">启动燃料</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="text-muted">还没有升级件</p>'}
    <div class="sov-add-up"><select class="input" id="sovAddUp"><option value="">添加升级件…</option>${opts}</select></div>
    <p class="text-muted sov-foot">剩余：电力 ${num(r.freeP)} · 劳动力 ${num(r.freeW)}　｜　燃料每小时：${reagentName(ICE)} ${num(r.fuel[ICE])} · ${reagentName(GAS)} ${num(r.fuel[GAS])}　｜　启动燃料：${reagentName(ICE)} ${num(r.startup[ICE])} · ${reagentName(GAS)} ${num(r.startup[GAS])}</p></div>`;
}

function transportCard(id, e, r, R) {
  const others = P.list.filter((x) => x !== id);
  let body = '';
  if (e.mode === 'export') {
    const f = r.out;
    body = `<div class="sov-form"><label>目的星系<select class="input" data-sov-field="to"><option value="0">选择…</option>${others.map((x) =>
      `<option value="${x}"${x === e.to ? ' selected' : ''}>${esc(D.sys.get(x).name)}${P.sys[x].mode === 'import' ? '' : '（未设为导入）'}</option>`).join('')}</select></label>
      <label>数量<input class="input" type="number" min="0" step="100" data-sov-field="amount" value="${Number(e.amount) || 0}"></label>
      <span class="text-muted">本星系天钩劳动力 ${num(r.res.wf)}（机械工具产出的不能导出）</span></div>
      ${f?.ok ? `<p class="sov-route">路线：${f.path.map((x) => `<a data-sov-sys="${x}">${esc(D.sys.get(x).name)}</a>`).join(' → ')}（${f.path.length - 1} 跳）</p>` : ''}`;
  } else if (e.mode === 'import') {
    const list = r.sources || [];
    body = list.length ? `<table class="pi-table"><thead><tr><th>来源</th><th class="num">数量</th><th>路线</th></tr></thead><tbody>${list.map((f) =>
      `<tr><td><a data-sov-sys="${f.from}">${esc(D.sys.get(f.from).name)}</a></td><td class="num">${num(f.amount)}</td><td>${f.path.length - 1} 跳</td></tr>`).join('')}</tbody></table>`
      : '<p class="text-muted">还没有星系向这里导出</p>';
    body += `<p class="text-muted">最多 3 个来源（${list.length} / 3）</p>`;
  } else if (e.mode === 'transit') {
    body = r.flows.length ? `<p>经过的劳动力：</p><ul class="sov-flows">${r.flows.map((f) => `<li>${esc(D.sys.get(f.from).name)} → ${esc(D.sys.get(f.to).name)}：${num(f.amount)}</li>`).join('')}</ul>`
      : '<p class="text-muted">目前没有劳动力经过这里。</p>';
  } else body = '<p class="text-muted">本星系劳动力只自用。</p>';
  return `<div class="pi-card"><div class="pi-card-head"><h3>劳动力运输</h3><span class="text-muted">只能在同一联盟的星系间沿星门运输</span></div>
    <div class="segmented sov-modes">${Object.entries(MODE_NAME).map(([k, v]) => `<button data-sov-mode="${k}" class="${e.mode === k ? 'active' : ''}">${v}</button>`).join('')}</div>${body}</div>`;
}

function planetsCard(id, s, r) {
  const rows = r.res.planets.map((p) => {
    const [tname, kind] = PLANET[p.type] || ['?', ''];
    const what = kind === ICE || kind === GAS ? `${num(p.value)} ${esc(reagentName(kind))} / 小时` : `${num(p.value)} ${RES_NAME[kind] || ''}`;
    return `<tr class="${p.on ? '' : 'sov-off'}"><td><label class="sov-check"><input type="checkbox" data-sov-planet="${p.pid}"${p.on ? ' checked' : ''}> ${esc(s.name)} ${ROMAN[p.idx] || p.idx}</label></td><td>${tname}</td><td class="num">${what}</td></tr>`;
  }).join('');
  return `<div class="pi-card"><div class="pi-card-head"><h3>行星与天钩</h3><span class="text-muted">勾选 = 装了轨道天钩</span>
      <span class="toolbar-spacer"></span><button class="btn btn-ghost btn-sm" data-sov-planets="on">全选</button><button class="btn btn-ghost btn-sm" data-sov-planets="off">全不选</button></div>
    <div class="pi-table-wrap"><table class="pi-table sov-table"><thead><tr><th>天体</th><th>类型</th><th class="num">产出</th></tr></thead><tbody>
      <tr><td>恒星</td><td>—</td><td class="num">${num(r.res.star)} 电力</td></tr>${rows}</tbody></table></div>
    <p class="text-muted sov-foot">试剂仓可存 ${D.sov.reagentHours} 小时产量</p></div>`;
}

// ---------- 总览 ----------
function overviewHtml(R) {
  if (!P.list.length) return introHtml() + ioCard();
  const T = { p: 0, pu: 0, w: 0, wu: 0, ice: 0, gas: 0, iceUse: 0, gasUse: 0, iceStart: 0, gasStart: 0, run: 0, all: 0 };
  const rows = P.list.map((id) => {
    const s = D.sys.get(id), r = R.get(id), e = P.sys[id];
    const run = r.ups.filter((x) => x.state === 'ok').length;
    T.p += r.powerTotal; T.pu += r.usedP; T.w += r.wfTotal; T.wu += r.usedW; T.run += run; T.all += e.ups.length;
    T.ice += r.res[ICE]; T.gas += r.res[GAS]; T.iceUse += r.fuel[ICE]; T.gasUse += r.fuel[GAS]; T.iceStart += r.startup[ICE]; T.gasStart += r.startup[GAS];
    return `<tr data-sov-sys="${id}"><td><span class="sov-dot ${statusOf(r)}"></span> ${esc(s.name)}</td><td>${esc(D.regions.get(s.region))}</td>
      <td class="num${r.usedP > r.powerTotal ? ' down' : ''}">${num(r.usedP)} / ${num(r.powerTotal)}</td><td class="num">${num(r.usedW)} / ${num(r.wfTotal)}</td>
      <td>${e.mode ? MODE_NAME[e.mode] + (e.mode === 'export' ? ' ' + num(r.exp) : e.mode === 'import' ? ' ' + num(r.imp) : '') : ''}</td>
      <td class="num">${run} / ${e.ups.length}</td><td class="num">${num(r.res[ICE] - r.fuel[ICE])}</td><td class="num">${num(r.res[GAS] - r.fuel[GAS])}</td>
      <td class="sov-warn-cell">${r.warn.map(esc).join('；')}</td></tr>`;
  }).join('');
  const reagentRow = (id, prod, use, start) => {
    const net = prod - use, vol = D.sov.reagents[id].volume;
    const price = D.prices?.get(id)?.sell;
    return `<tr><td>${esc(reagentName(id))}</td><td class="num">${num(prod)}</td><td class="num">${num(use)}</td><td class="num ${net < 0 ? 'down' : 'up'}">${num(net)}</td>
      <td class="num">${num(use * 24 * 30)}</td><td class="num">${num(use * 24 * 30 * vol)} m³</td><td class="num">${num(start)}</td>
      <td class="num">${price ? ctx.formatISK(use * 24 * 30 * price) : '—'}</td></tr>`;
  };
  if (!D.prices) ctx.getHubPrices([ICE, GAS]).then((m) => { D.prices = m; if (S.tab === 'overview') render(); }).catch(() => { D.prices = new Map(); });
  return `<div class="pi-stats">
      <div><span>星系</span><b>${P.list.length}</b></div><div><span>升级件 运行 / 总数</span><b>${T.run} / ${T.all}</b></div>
      <div><span>电力 已用 / 总量</span><b>${num(T.pu)} / ${num(T.p)}</b></div><div><span>劳动力 已用 / 总量</span><b>${num(T.wu)} / ${num(T.w)}</b></div>
      <div><span>有问题的星系</span><b class="${[...R.values()].some((r) => r.warn.length) ? 'down' : ''}">${[...R.values()].filter((r) => r.warn.length).length}</b></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>燃料试剂</h3><span class="text-muted">按吉他最低卖价</span></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>试剂</th><th class="num">产出 / 小时</th><th class="num">消耗 / 小时</th><th class="num">净 / 小时</th><th class="num">30 天消耗</th><th class="num">30 天体积</th><th class="num">启动燃料合计</th><th class="num">30 天价值</th></tr></thead>
      <tbody>${reagentRow(ICE, T.ice, T.iceUse, T.iceStart)}${reagentRow(GAS, T.gas, T.gasUse, T.gasStart)}</tbody></table></div></div>
    <div class="pi-card"><div class="pi-card-head"><h3>各星系</h3><span class="text-muted">点一行进入该星系</span></div>
      <div class="pi-table-wrap sov-overview"><table class="pi-table"><thead><tr><th>星系</th><th>星域</th><th class="num">电力</th><th class="num">劳动力</th><th>运输</th><th class="num">升级件</th><th class="num">冰 净/时</th><th class="num">气 净/时</th><th>问题</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    ${ioCard()}`;
}
function ioCard() {
  return `<div class="pi-card"><div class="pi-card-head"><h3>导出 / 导入规划</h3><span class="text-muted">JSON 文件，可分享给盟友</span></div>
    <div class="sov-io"><button class="btn" data-sov-export>导出规划</button><label class="btn">导入规划<input type="file" accept=".json,application/json" id="sovImport" hidden></label></div></div>`;
}

// ---------- ESI：我的主权设施 ----------
function renderEsi(body) {
  if (!IS_TQ) { body.innerHTML = `<div class="empty-state"><p>主权中心与天钩接口只在宁静服提供，${esc(SERVER.full)}的 ESI 还没有。</p></div>`; return; }
  if (!ctx.hasEsiToken()) { body.innerHTML = '<div class="empty-state"><p>先在「个人中心」绑定角色。读取主权中心需要军团的董事或站点经理等职位。</p></div>'; return; }
  if (!ctx.hasScopeGroup('sov')) { body.innerHTML = ctx.scopeNeededHtml('sov', '读取军团的主权中心与天钩'); return; }
  if (!S.esi && !S.esiLoading) { loadEsi(); }
  if (S.esiLoading) { body.innerHTML = `<div class="empty-state"><p>${esc(S.esiProgress || '读取中…')}</p></div>`; return; }
  const d = S.esi;
  if (d.error) { body.innerHTML = `<div class="empty-state"><p>${esc(d.error)}</p><button class="btn" data-sov-esi-reload>重试</button></div>`; return; }
  if (!d.hubs.length && !d.skyhooks.length) { body.innerHTML = `<div class="empty-state"><p>${esc(d.corpName)} 名下没有主权中心或天钩。</p><button class="btn" data-sov-esi-reload>刷新</button></div>`; return; }
  const now = Date.now();
  const byRegion = new Map();
  for (const h of d.hubs) {
    const s = D.sys.get(h.solar_system_id);
    const k = s?.region || 0;
    if (!byRegion.has(k)) byRegion.set(k, []);
    byRegion.get(k).push(h);
  }
  const hubRow = (h) => {
    const s = D.sys.get(h.solar_system_id);
    if (h.error) return `<tr><td>${esc(s?.name || h.solar_system_id)}</td><td colspan="6" class="text-muted">${esc(h.error)}</td></tr>`;
    const ups = (h.upgrades || []).map((u) => `<span class="sov-chip c-${(u.power_state || '').toLowerCase()}" title="${STATE_NAME[u.power_state] || u.power_state}">${esc(D.up.get(u.type_id)?.name || u.type_id)}</span>`).join('');
    const bay = h.reagent_bay;
    const fuel = (bay?.reagents || []).map((x) => {
      const left = x.amount - x.burning_per_hour * (now - Date.parse(bay.last_updated)) / 3600e3;
      const hours = x.burning_per_hour ? left / x.burning_per_hour : Infinity;
      return `<div>${esc(reagentName(x.type_id))} ${num(Math.max(0, left))}${x.burning_per_hour ? `（${num(x.burning_per_hour)}/时，<b class="${hours < 72 ? 'down' : ''}">${hours < 48 ? num(hours) + ' 小时' : num(hours / 24) + ' 天'}</b>）` : ''}</div>`;
    }).join('') || '—';
    const t = h.workforce_transport;
    const conf = t?.configuration || {};
    const tr = conf.export ? `导出 ${num(conf.export.amount)} → ${esc(D.sys.get(conf.export.solar_system_id)?.name || '')}` :
      conf.import ? `导入 ← ${conf.import.sources.map((x) => esc(D.sys.get(x.solar_system_id)?.name || x.solar_system_id)).join('、')}` : conf.transit ? '中转' : '—';
    const res = h.resources || {};
    return `<tr><td><a data-sov-map="${h.solar_system_id}">${esc(s?.name || h.solar_system_id)}</a></td>
      <td class="num">${num(res.power?.allocated)} / ${num(res.power?.available)}</td><td class="num">${num(res.workforce?.allocated)} / ${num(res.workforce?.available)}</td>
      <td class="sov-chips">${ups || '—'}</td><td>${fuel}</td><td>${tr}</td>
      <td>${h.vulnerability_window ? `${fmtTime(h.vulnerability_window.start)}–${fmtTime(h.vulnerability_window.end, true)}` : ''}</td></tr>`;
  };
  const hubsHtml = [...byRegion].sort((a, b) => (D.regions.get(a[0]) || '').localeCompare(D.regions.get(b[0]) || '', 'zh')).map(([rid, list]) =>
    `<div class="pi-card"><div class="pi-card-head"><h3>${esc(D.regions.get(rid) || '未知星域')}</h3><span class="text-muted">${list.length} 个主权中心</span></div>
      <div class="pi-table-wrap"><table class="pi-table sov-esi-table"><thead><tr><th>星系</th><th class="num">电力 已分配 / 可用</th><th class="num">劳动力 已分配 / 可用</th><th>升级件（按优先级）</th><th>燃料仓（剩余可烧）</th><th>劳动力运输</th><th>易损窗口</th></tr></thead>
      <tbody>${list.sort((a, b) => (D.sys.get(a.solar_system_id)?.name || '').localeCompare(D.sys.get(b.solar_system_id)?.name || '')).map(hubRow).join('')}</tbody></table></div></div>`).join('');
  const skyRows = d.skyhooks.map((k) => {
    const pl = planetInfo(k.planet_id);
    if (k.error) return `<tr><td>${esc(pl.name)}</td><td colspan="5" class="text-muted">${esc(k.error)}</td></tr>`;
    const reag = (k.reagents || []).map((x) => {
      const hours = (now - Date.parse(x.last_cycle)) / 3600e3;
      return `${esc(reagentName(x.type_id))} 安全 ${num(x.secured_stock)} · 非安全 ${num(x.unsecured_stock)}<span class="text-muted">（${num(hours)} 小时前）</span>`;
    }).join('<br>');
    const out = pl.kind === ICE || pl.kind === GAS ? `${num(pl.value)} ${reagentName(pl.kind)}/时` : pl.kind ? `${num(k.effective_workforce ?? pl.value)} ${RES_NAME[pl.kind]}` : '';
    return `<tr><td>${esc(pl.name)}</td><td>${esc(pl.type)}</td><td>${k.is_active ? '<span class="sov-state s-ok">产出中</span>' : '<span class="sov-state s-low">未产出</span>'}</td>
      <td class="num">${out}</td><td>${reag || '—'}</td><td>${esc(SKYHOOK_STATE[k.state] || k.state || '')}${k.theft_vulnerability ? `<div class="text-muted">被盗窗口 ${fmtTime(k.theft_vulnerability.start)}–${fmtTime(k.theft_vulnerability.end, true)}</div>` : ''}</td></tr>`;
  }).join('');
  body.innerHTML = `<div class="sov-esi-head"><span>${esc(d.corpName)} · ${d.hubs.length} 个主权中心 · ${d.skyhooks.length} 个天钩 · 读取于 ${fmtTime(new Date(d.at).toISOString())}</span>
      <span class="toolbar-spacer"></span><button class="btn" data-sov-esi-reload>刷新</button><button class="btn btn-primary" data-sov-esi-import>导入到规划</button></div>
    <p class="text-muted sov-foot">升级件颜色：<span class="sov-chip c-online">在线</span><span class="sov-chip c-low">低电量</span><span class="sov-chip c-offline">离线</span><span class="sov-chip c-pending">等待中</span>　导入会用这些星系替换当前规划。</p>
    ${hubsHtml}
    ${d.skyhooks.length ? `<div class="pi-card"><div class="pi-card-head"><h3>天钩</h3><span class="text-muted">${d.skyhooks.length} 个</span></div>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>行星</th><th>类型</th><th>状态</th><th class="num">产出</th><th>试剂库存</th><th>建筑状态</th></tr></thead><tbody>${skyRows}</tbody></table></div></div>` : ''}`;
}
function fmtTime(iso, short) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return short ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function planetInfo(pid) {
  for (const s of D.sys.values()) {
    if (!s.res) continue;
    const p = s.res[1].find((x) => x[0] === pid);
    if (p) return { sys: s.id, name: `${s.name} ${ROMAN[p[2]] || p[2]}`, type: PLANET[p[1]]?.[0] || '', kind: PLANET[p[1]]?.[1], value: p[3] };
  }
  return { name: String(pid), type: '' };
}

async function loadEsi() {
  S.esiLoading = true; S.esiProgress = '读取角色军团…';
  try {
    const me = ctx.tokenInfo();
    const info = await ctx.fetchESI(`/characters/${me.character_id}/`);
    const corp = info.corporation_id;
    const names = await ctx.resolveNames([corp]).catch(() => ({ names: new Map() }));
    const corpName = names.names.get(corp) || String(corp);
    S.esiProgress = '读取主权中心列表…'; if (S.tab === 'esi') renderEsi($('sovBody'));
    const [hubList, skyList] = await Promise.all([
      esiNew(`/corporations/${corp}/structures/sovereignty-hubs`, true),
      esiNew(`/corporations/${corp}/structures/skyhooks`, true).catch(() => ({ skyhooks: [] }))
    ]);
    const hubs = [], skyhooks = [];
    const all = [...(hubList.sovereignty_hubs || []).map((h) => ['hub', h]), ...(skyList.skyhooks || []).map((k) => ['sky', k])];
    let done = 0;
    // 详情逐个读（接口限流 300 次 / 15 分钟），4 路并发
    const queue = all.slice();
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const [kind, x] = queue.shift();
        try {
          if (kind === 'hub') hubs.push(await esiNew(`/corporations/${corp}/structures/sovereignty-hubs/${x.id}`, true));
          else skyhooks.push(await esiNew(`/corporations/${corp}/structures/skyhooks/${x.id}`, true));
        } catch (e) {
          (kind === 'hub' ? hubs : skyhooks).push({ ...x, error: '读取失败：' + (e.esiError || e.message) });
        }
        done++;
        S.esiProgress = `读取详情 ${done} / ${all.length}…`;
        if (S.tab === 'esi' && done % 3 === 0) renderEsi($('sovBody'));
      }
    }));
    S.esi = { corp, corpName, hubs, skyhooks, at: Date.now() };
  } catch (e) {
    const why = e.status === 403 ? '没有权限：读取主权中心需要军团董事或站点经理等职位' : e.status === 401 ? '授权已失效，请重新绑定' : '读取失败：' + (e.esiError || e.message);
    S.esi = { error: why, hubs: [], skyhooks: [] };
  }
  S.esiLoading = false;
  if (S.tab === 'esi') renderEsi($('sovBody'));
}

function importEsi() {
  const d = S.esi;
  const plan = { list: [], sys: {} };
  const hooks = new Map();
  for (const k of d.skyhooks) {
    const pl = planetInfo(k.planet_id);
    if (!pl.sys) continue;
    if (!hooks.has(pl.sys)) hooks.set(pl.sys, new Set());
    if (k.is_active !== false) hooks.get(pl.sys).add(k.planet_id);
  }
  for (const h of d.hubs) {
    const id = h.solar_system_id, s = D.sys.get(id);
    if (!s?.res || h.error) continue;
    const t = h.workforce_transport?.configuration || {};
    const known = hooks.get(id);
    plan.list.push(id);
    plan.sys[id] = {
      // 有本军团天钩数据的星系：没有天钩的行星取消勾选；没有的星系（天钩可能属于盟友军团）保持全选
      off: known ? s.res[1].filter((p) => !known.has(p[0])).map((p) => p[0]) : [],
      ups: (h.upgrades || []).map((u) => [u.type_id, u.power_state !== 'Offline']),
      mode: t.export ? 'export' : t.import ? 'import' : t.transit ? 'transit' : '',
      to: t.export?.solar_system_id || 0, amount: t.export?.amount || 0
    };
  }
  if (!plan.list.length) { ctx.showToast('没有可导入的主权中心', 'error'); return; }
  P = plan; sortList(); save();
  S.tab = 'plan'; S.cur = P.list[0];
  ctx.showToast(`已导入 ${P.list.length} 个星系`, 'success');
  render();
}

// ---------- 事件 ----------
function bindEvents(main) {
  main.addEventListener('click', (ev) => {
    const t = ev.target;
    const tab = t.closest('[data-sov-tab]');
    if (tab) { S.tab = tab.dataset.sovTab; S.pick = null; render(); ctx.closeDrawer?.(); return; }
    const hit = t.closest('[data-sov-hit]');
    if (hit) {
      const [kind, id] = hit.dataset.sovHit.split(':');
      if (kind === 'sys') { addSystems([Number(id)]); S.cur = Number(id); S.query = ''; S.tab = 'plan'; render(); ctx.closeDrawer?.(); return; }
      S.pick = { kind, id: Number(id), name: hit.querySelector('b').textContent };
      renderPick(); return;
    }
    if (t.closest('[data-sov-pick-cancel]')) { S.pick = null; renderPick(); return; }
    if (t.closest('[data-sov-pick-add]')) {
      const want = $('sovPickOwner')?.value || '';
      let ids = areaSystems(S.pick.kind, S.pick.id);
      if (want) ids = ids.filter((id) => { const o = D.owners?.get(id); const k = o ? (o.alliance ? 'a' + o.alliance : 'f' + o.faction) : 'none'; return k === want; });
      const n = addSystems(ids);
      ctx.showToast(n ? `已加入 ${n} 个星系` : '这些星系都已在规划里', n ? 'success' : 'info');
      if (n && !P.list.includes(S.cur)) S.cur = ids.find((id) => P.list.includes(id));
      S.pick = null; S.query = ''; if (S.tab === 'esi') S.tab = 'plan';
      if (!S.cur) S.cur = P.list[0];
      render(); return;
    }
    const sys = t.closest('[data-sov-sys]');
    if (sys) { S.cur = Number(sys.dataset.sovSys); S.tab = 'plan'; render(); ctx.closeDrawer?.(); return; }
    const map = t.closest('[data-sov-map]');
    if (map) { ev.preventDefault(); ctx.openMapSystem(Number(map.dataset.sovMap)); return; }
    const rm = t.closest('[data-sov-remove]');
    if (rm) { removeSystem(Number(rm.dataset.sovRemove)); render(); return; }
    if (t.closest('[data-sov-clear]')) { if (confirm('清空整个规划？')) { P = { list: [], sys: {} }; S.cur = 0; save(); render(); } return; }
    const up = t.closest('[data-sov-up]');
    if (up) {
      const [op, i] = up.dataset.sovUp.split(':'); const k = Number(i);
      const list = P.sys[S.cur].ups;
      if (op === 'up' && k > 0) [list[k - 1], list[k]] = [list[k], list[k - 1]];
      if (op === 'down' && k < list.length - 1) [list[k + 1], list[k]] = [list[k], list[k + 1]];
      if (op === 'toggle') list[k][1] = !list[k][1];
      if (op === 'del') list.splice(k, 1);
      save(); render(); return;
    }
    const mode = t.closest('[data-sov-mode]');
    if (mode) { const e = P.sys[S.cur]; e.mode = mode.dataset.sovMode; save(); render(); return; }
    const pl = t.closest('[data-sov-planets]');
    if (pl) { const e = P.sys[S.cur]; e.off = pl.dataset.sovPlanets === 'on' ? [] : D.sys.get(S.cur).res[1].map((p) => p[0]); save(); render(); return; }
    if (t.closest('[data-sov-export]')) { exportPlan(); return; }
    if (t.closest('[data-sov-esi-reload]')) { S.esi = null; render(); return; }
    if (t.closest('[data-sov-esi-import]')) { if (!P.list.length || confirm('用 ESI 读到的配置替换当前规划？')) importEsi(); return; }
  });
  main.addEventListener('input', (ev) => {
    if (ev.target.id === 'sovSearch') { S.query = ev.target.value; S.pick = null; renderPick(); }
  });
  main.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'sovAddUp' && t.value) {
      const e = P.sys[S.cur], u = D.up.get(Number(t.value));
      if (e.ups.some(([tid]) => D.up.get(tid)?.excl === u.excl)) { ctx.showToast('同一组只能装一个', 'error'); return; }
      e.ups.push([u.id, true]); save(); render(); return;
    }
    if (t.dataset.sovPlanet) {
      const e = P.sys[S.cur], pid = Number(t.dataset.sovPlanet);
      e.off = t.checked ? e.off.filter((x) => x !== pid) : [...e.off, pid];
      save(); render(); return;
    }
    if (t.dataset.sovField) {
      const e = P.sys[S.cur];
      e[t.dataset.sovField] = Math.max(0, Number(t.value) || 0);
      save(); render(); return;
    }
    if (t.id === 'sovImport' && t.files?.[0]) {
      t.files[0].text().then((text) => {
        const d = JSON.parse(text);
        if (!Array.isArray(d.list) || typeof d.sys !== 'object') throw new Error('不是主权规划文件');
        P = { list: d.list.map(Number).filter((id) => D.sys.get(id)?.res), sys: d.sys };
        for (const id of P.list) entry(id);
        sortList(); save(); S.cur = P.list[0] || 0;
        ctx.showToast(`已导入 ${P.list.length} 个星系`, 'success');
        render();
      }).catch((e) => ctx.showToast('导入失败：' + e.message, 'error'));
    }
  });
  main.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'sovSearch' && ev.key === 'Enter') { const first = $('sovPick')?.querySelector('[data-sov-hit]'); first?.click(); }
    if (ev.target.id === 'sovSearch' && ev.key === 'Escape') { S.query = ''; S.pick = null; ev.target.value = ''; renderPick(); }
  });
}

function exportPlan() {
  const blob = new Blob([JSON.stringify({ app: 'eve-market sov plan', v: 1, sde: D.sov.sdeBuild, ...P }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `主权规划-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
