// ===== 战场统计（Battle Report）=====
// 选择星系（可勾选星门邻近星系）与时间段，向击杀记录服务读取期间全部玩家击杀与攻击者，
// 按联盟（无联盟时按军团）汇总，自动推测 A / B 双方阵营（可手动调整，多方混战时可加 C / D 方），统计各方人数、损失、舰船组成与损失明细。
// 路由：#kb/br（设置）、#kb/br/<星系,…>/<开始>-<结束>[/<A 方,…>/<B 方,…>[/<C 方,…>[/<D 方,…>]]]（时间为 Unix 秒，可分享）
import { initReplay, mountReplay, stopReplay, resizeReplay } from './kb-br-replay.js?v=v6';
import { getTz, setTz, tzLabel, isoIn, parseIn } from './eve-time.js?v=v1';
let ctx;                       // kb-page 提供的工具：app, kb, request, absorbNames, partyName, typeName, loadTypes, avatar, entityLink, IMG
const $ = (id) => document.getElementById(id);
const PODS = new Set([670, 33328]);
const MAX_SYSTEMS = 30;
const MAX_HOURS = 72;
const QUICK = [1, 3, 6, 12, 24, 72];

const NARROW_KEY = 'eve-br-narrow';
const BR = {
  picked: [],                // 搜索添加的星系（总是选中）
  checked: new Set(),        // 勾选的邻近星系
  jumps: 1,
  start: 0, end: 0,          // Unix 秒
  data: null, key: '',       // 当前结果与对应的查询
  parties: new Map(),        // 势力 id -> { id, kind, pilots:Set, kills:Set, losses, lost }
  side: new Map(),           // 势力 id -> 'A' | 'B' | 'C' | 'D'（未分配不记录）
  view: 'A',                 // 窄屏下显示哪一方的明细
  pq: '',                   // 查玩家：名字或角色 ID（筛选各方的逐船列表）
  zkAll: false,              // 逐船列表显示全部
  tab: 'sides',              // 战况走势下面：sides 阵营对比 / pilots 玩家统计
  psort: { key: 'dmg', dir: 'desc' },   // 玩家统计的排序
  pside: 'all',              // 玩家统计只看哪一方
  ptAll: false,              // 玩家统计显示全部
  narrow: readNarrow()       // 窄版：像 zKillboard 那样居中、限宽（宽屏才有区别）
};
function readNarrow() {
  try { return localStorage.getItem(NARROW_KEY) === '1'; } catch { return false; }
}
const ZK_LIMIT = 300;      // 逐船列表每方先显示多少行
const SIDE_ALL = ['A', 'B', 'C', 'D'];
// 当前的各方：总有 A、B；C、D 有势力时才出现
function sidesUsed() {
  const used = new Set(BR.side.values());
  return ['A', 'B', ...['C', 'D'].filter((s) => used.has(s))];
}
// 移出势力后 C 方空了而 D 方还有：D 改叫 C
function compactSides() {
  const used = new Set(BR.side.values());
  if (!used.has('C') && used.has('D')) for (const [id, s] of BR.side) if (s === 'D') BR.side.set(id, 'C');
}

export function initBr(context) {
  ctx = context;
  initReplay({
    IMG: (...a) => ctx.IMG(...a), typeName: (t) => ctx.typeName(t), partyName: (id) => ctx.partyName(id),
    get esc() { return ctx.app.esc; }, get formatISK() { return ctx.app.formatISK; }
  });
  window.addEventListener('resize', resizeReplay);
}

// ---------- 时间：默认北京时间（UTC+8），可切换为 EVE 时间（UTC），见 eve-time.js；链接里始终是 Unix 秒 ----------
const toInput = (sec) => isoIn(sec).slice(0, 16);
const fromInput = (v) => parseIn(v);
const fmtTime = (sec) => isoIn(sec).slice(0, 16).replace('T', ' ');
const fmtClock = (sec) => isoIn(sec).slice(11, 16);

function defaultRange() {
  const end = Math.ceil(Date.now() / 1000 / 300) * 300;
  return [end - 3 * 3600, end];
}

// ---------- 路由 ----------
export function parseHash(hash) {
  const m = /^#kb\/br(?:\/([\d,]+)\/(\d+)-(\d+)(?:\/([\d,]*|-)\/([\d,]*|-)(?:\/([\d,]*|-))?(?:\/([\d,]*|-))?)?)?/.exec(hash);
  if (!m) return null;
  const ids = (v) => (v && v !== '-' ? v.split(',').map(Number).filter(Boolean) : []);
  return m[1] ? { systems: ids(m[1]), start: Number(m[2]), end: Number(m[3]), a: ids(m[4]), b: ids(m[5]), c: ids(m[6]), d: ids(m[7]) } : {};
}

function hashFor(withSides = true) {
  const systems = selectedSystems();
  let h = `#kb/br/${systems.join(',')}/${BR.start}-${BR.end}`;
  if (withSides && BR.side.size) {
    const list = (s) => [...BR.side].filter(([, v]) => v === s).map(([id]) => id).join(',') || '-';
    h += '/' + sidesUsed().map(list).join('/');
  }
  return h;
}

function selectedSystems() {
  return [...new Set([...BR.picked, ...BR.checked])];
}

// 进入战场统计页：hash 带参数时直接生成统计
export async function renderBr(hash) {
  const p = parseHash(hash) || {};
  if (p.systems?.length) {
    // 链接里的第一个星系作为已添加星系，其余在 2 跳内的作为勾选的邻近星系，更远的也作为已添加星系
    const [first, ...rest] = p.systems;
    const near = new Map(ctx.kb.systemNeighbors(first, 2).map((n) => [n.id, n.jumps]));
    BR.picked = [first, ...rest.filter((id) => !near.has(id))];
    BR.checked = new Set(rest.filter((id) => near.has(id)));
    BR.jumps = [...BR.checked].some((id) => near.get(id) === 2) ? 2 : 1;
    BR.start = p.start;
    BR.end = p.end;
  } else if (!BR.start) {
    [BR.start, BR.end] = defaultRange();
  }
  const main = $('kbMain');
  main.innerHTML = `
    <section class="kb-br">
      <div class="kb-br-head">
        <a class="btn kb-br-back" href="#kb" data-kb-home>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span>返回击杀记录</span>
        </a>
        <h2>战场统计</h2>
      </div>
      <div class="kb-br-form" id="brForm"></div>
      <div id="brResult"></div>
    </section>`;
  renderForm();
  bindForm();
  bindDocument();
  if (p.systems?.length) await loadResult(p);
}

// ---------- 设置表单 ----------
function neighborsOf(ids, jumps) {
  const out = new Map();
  for (const id of ids) {
    for (const n of ctx.kb.systemNeighbors(id, jumps)) {
      if (ids.includes(n.id)) continue;
      if (!out.has(n.id) || out.get(n.id).jumps > n.jumps) out.set(n.id, n);
    }
  }
  return [...out.values()].sort((a, b) => a.jumps - b.jumps || ctx.kb.systemLabel(a.id).name.localeCompare(ctx.kb.systemLabel(b.id).name, 'zh'));
}

function sysName(id) {
  const l = ctx.kb.systemLabel(id);
  return `${ctx.app.esc(l.name)} <b style="color:${l.color}">${l.secText}</b>`;
}

function renderForm() {
  const near = BR.picked.length ? neighborsOf(BR.picked, BR.jumps) : [];
  // 切换跳数后不在范围内的勾选项移除
  const nearIds = new Set(near.map((n) => n.id));
  for (const id of BR.checked) if (!nearIds.has(id)) BR.checked.delete(id);
  const hours = (BR.end - BR.start) / 3600;
  $('brForm').innerHTML = `
    <div class="kb-br-row">
      <label class="kb-br-label">星系</label>
      <div class="kb-br-field">
        <div class="search-box kb-br-search">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="brSystem" placeholder="输入星系名添加" autocomplete="off" spellcheck="false" aria-label="添加星系">
          <div class="kb-suggest" id="brSuggest" hidden></div>
        </div>
        <div class="kb-br-picked">${BR.picked.map((id) => `<span class="kb-br-chip">${sysName(id)}<button data-br-unpick="${id}" aria-label="移除">×</button></span>`).join('') || '<span class="text-muted">还没有选择星系</span>'}</div>
      </div>
    </div>
    ${BR.picked.length ? `<div class="kb-br-row">
      <label class="kb-br-label">邻近星系</label>
      <div class="kb-br-field">
        <div class="kb-br-near-head">
          <div class="segmented" role="group" aria-label="邻近范围">
            ${[1, 2].map((j) => `<button data-br-jumps="${j}" class="${BR.jumps === j ? 'active' : ''}">${j} 跳内</button>`).join('')}
          </div>
          <button class="link-btn" data-br-all="1">全选</button><button class="link-btn" data-br-all="0">清空</button>
          <span class="text-muted">已选 ${selectedSystems().length} 个星系</span>
        </div>
        <div class="kb-br-near">${near.map((n) => `<label class="kb-br-near-item"><input type="checkbox" data-br-near="${n.id}"${BR.checked.has(n.id) ? ' checked' : ''}><span>${sysName(n.id)}</span><small>${n.jumps} 跳</small></label>`).join('') || '<span class="text-muted">没有星门相连的星系（虫洞）</span>'}</div>
      </div>
    </div>` : ''}
    <div class="kb-br-row">
      <label class="kb-br-label">时间</label>
      <div class="kb-br-field">
        <div class="segmented kb-br-tz" role="group" aria-label="时区">${[['cn', '北京时间 UTC+8'], ['eve', 'EVE 时间']].map(([z, l]) => `<button type="button" data-br-tz="${z}" class="${getTz() === z ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="kb-br-time">
          <input type="datetime-local" id="brStart" value="${toInput(BR.start)}" step="60" aria-label="开始时间">
          <span>至</span>
          <input type="datetime-local" id="brEnd" value="${toInput(BR.end)}" step="60" aria-label="结束时间">
        </div>
        <div class="kb-br-quick">最近 ${QUICK.map((h) => `<button class="${Math.abs(hours - h) < 0.01 && Math.abs(BR.end - Date.now() / 1000) < 600 ? 'active' : ''}" data-br-quick="${h}">${h} 小时</button>`).join('')}</div>
      </div>
    </div>
    <div class="kb-br-actions">
      <button class="btn btn-primary" data-br-go${BR.picked.length ? '' : ' disabled'}>生成战场统计</button>
      <span class="text-muted">最多 ${MAX_SYSTEMS} 个星系、${MAX_HOURS} 小时；宁静服超出本站保存期限的时间段从 zKillboard 读取</span>
    </div>`;
}

function bindForm() {
  const form = $('brForm');
  form.addEventListener('input', ctx.app.debounce((e) => { if (e.target.id === 'brSystem') suggest(e.target.value); }, 150));
  form.addEventListener('keydown', (e) => {
    if (e.target.id === 'brSystem' && e.key === 'Enter') { e.preventDefault(); $('brSuggest').querySelector('[data-br-pick]')?.click(); }
    if (e.target.id === 'brSystem' && e.key === 'Escape') $('brSuggest').hidden = true;
  });
  form.addEventListener('change', (e) => {
    const near = e.target.closest('[data-br-near]');
    if (near) {
      const id = Number(near.dataset.brNear);
      if (near.checked) BR.checked.add(id); else BR.checked.delete(id);
      form.querySelector('.kb-br-near-head .text-muted').textContent = `已选 ${selectedSystems().length} 个星系`;
    }
    if (e.target.id === 'brStart' || e.target.id === 'brEnd') {
      const v = fromInput(e.target.value);
      if (Number.isFinite(v)) BR[e.target.id === 'brStart' ? 'start' : 'end'] = v;
      form.querySelectorAll('[data-br-quick]').forEach((b) => b.classList.remove('active'));
    }
  });
  form.addEventListener('click', (e) => {
    const el = (sel) => e.target.closest(sel);
    let x;
    if ((x = el('[data-br-pick]'))) {
      const id = Number(x.dataset.brPick);
      if (!BR.picked.includes(id)) BR.picked.push(id);
      BR.checked.delete(id);
      renderForm();
      $('brSystem').focus();
      return;
    }
    if ((x = el('[data-br-unpick]'))) { BR.picked = BR.picked.filter((id) => id !== Number(x.dataset.brUnpick)); renderForm(); return; }
    if ((x = el('[data-br-jumps]'))) { BR.jumps = Number(x.dataset.brJumps); renderForm(); return; }
    if ((x = el('[data-br-tz]'))) { setTz(x.dataset.brTz); renderForm(); if (BR.data?.kills.length) renderResult(); return; }
    if ((x = el('[data-br-all]'))) {
      BR.checked = x.dataset.brAll === '1' ? new Set(neighborsOf(BR.picked, BR.jumps).map((n) => n.id)) : new Set();
      renderForm();
      return;
    }
    if ((x = el('[data-br-quick]'))) {
      const end = Math.ceil(Date.now() / 1000 / 60) * 60;
      BR.end = end;
      BR.start = end - Number(x.dataset.brQuick) * 3600;
      renderForm();
      return;
    }
    if (el('[data-br-go]')) go();
  });
}

// 点击搜索框以外的地方收起星系建议（只绑定一次）
let docBound = false;
function bindDocument() {
  if (docBound) return;
  docBound = true;
  document.addEventListener('click', (e) => { if (!e.target.closest('.kb-br-search') && $('brSuggest')) $('brSuggest').hidden = true; });
}

function suggest(text) {
  const box = $('brSuggest');
  const q = text.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }
  const npc = ctx.app.getNpcNames();
  const score = (name) => { const l = name.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : -1; };
  const list = npc ? Object.entries(npc.systems).map(([id, name]) => ({ id: Number(id), name, s: score(name) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length).slice(0, 8) : [];
  box.innerHTML = list.map((s) => { const l = ctx.kb.systemLabel(s.id); return `<button class="kb-suggest-item" data-br-pick="${s.id}"><i style="background:${l.color}"></i><span>${ctx.app.esc(s.name)} <b style="color:${l.color}">${l.secText}</b></span><small>${ctx.app.esc(l.region)}</small></button>`; }).join('') || '<p class="legend-empty">没有找到星系</p>';
  box.hidden = false;
}

function go() {
  const systems = selectedSystems();
  if (!systems.length) { ctx.app.showToast('请先选择星系', 'error'); return; }
  if (systems.length > MAX_SYSTEMS) { ctx.app.showToast(`最多选择 ${MAX_SYSTEMS} 个星系`, 'error'); return; }
  if (!(BR.end > BR.start)) { ctx.app.showToast('结束时间必须晚于开始时间', 'error'); return; }
  if (BR.end - BR.start > MAX_HOURS * 3600) { ctx.app.showToast(`时间段最长 ${MAX_HOURS} 小时`, 'error'); return; }
  BR.side.clear();
  const hash = hashFor(false);
  history.pushState(null, '', hash);
  loadResult({ systems, start: BR.start, end: BR.end, a: [], b: [], c: [], d: [] });
}

// ---------- 读取与汇总 ----------
async function loadResult(p) {
  const box = $('brResult');
  box.innerHTML = `<div class="kb-br-loading"><span class="spinner"></span>正在读取击杀记录…</div>`;
  const key = `${p.systems.join(',')}|${p.start}|${p.end}`;
  try {
    let data = BR.key === key && BR.data ? BR.data : await ctx.request(`br?systems=${p.systems.join(',')}&start=${p.start}&end=${p.end}`);
    // 开始时间早于本站保存期限：整段改由浏览器直接从 zKillboard 读取，只放在本页内存里，服务器不存
    if (!data.zk && beyondRetention(data, p.start)) data = await zkBattle(p, data, box);
    if (BR.key !== key) BR.zkAll = false;
    BR.data = data;
    BR.key = key;
    ctx.absorbNames(data.names);
    const types = new Set();
    for (const k of data.kills) { types.add(k[3]); for (const a of k[8]) if (a[3]) types.add(a[3]); }
    await ctx.loadTypes([...types]);
  } catch (error) {
    box.innerHTML = `<p class="kb-empty text-muted">读取失败：${ctx.app.esc(error.message)}</p>`;
    return;
  }
  summarize();
  if (p.a?.length || p.b?.length) {
    BR.side.clear();
    SIDE_ALL.forEach((s) => (p[s.toLowerCase()] || []).forEach((id) => BR.side.set(id, s)));
    compactSides();
  } else {
    autoSides();
    history.replaceState(null, '', hashFor());
  }
  renderResult();
  refreshDamage();
}

// ---------- 超出保存期限：浏览器直接读 zKillboard ----------
// zKillboard 不支持按起止时间查，只能按「星系 + 年 + 月」从新到旧翻页（每页 200 条，带完整击杀与估值）；
// 翻到比开始时间更早就停。换成与服务端 /br 相同的紧凑数组：没有玩家攻击者的（NPC 击杀）不算，只留玩家攻击者，价值用 zKillboard 估值
const ZK_PAGES = 60;   // 每个星系每个月最多翻的页数（吉他这样的星系一天约 200 条）
const beyondRetention = (d, start) => Boolean(d.retention_days) && start < Date.now() / 1000 - (d.retention_days - 1) * 86400;
async function zkBattle(p, local, box) {
  const months = [];
  for (let t = p.start; ; ) {
    const d = new Date(t * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (!months.some((x) => x[0] === y && x[1] === m)) months.push([y, m]);
    const next = Date.UTC(y, m, 1) / 1000;   // 下个月 1 日
    if (next >= p.end) break;
    t = next;
  }
  const progress = (i, page) => {
    const el = box.querySelector('.kb-br-loading');
    if (el) el.innerHTML = `<span class="spinner"></span>超出本站保存期限（${local.retention_days - 1} 天），正在从 zKillboard 读取：星系 ${i}/${p.systems.length} · 第 ${page} 页`;
  };
  const kills = new Map();
  let truncated = false;
  for (const [i, sys] of p.systems.entries()) {
    for (const [y, m] of months) {
      for (let page = 1; page <= ZK_PAGES; page++) {
        progress(i + 1, page);
        const list = await ctx.kb.fetchZkill(`solarSystemID/${sys}/year/${y}/month/${m}/page/${page}/`)
          .catch((e) => { throw new Error(`连不上 zKillboard（${e.message}），超出本站保存期限的时间段要从 zKillboard 读取`); });
        if (!Array.isArray(list) || !list.length) break;
        for (const km of list) {
          const t = Date.parse(km.killmail_time) / 1000;
          if (t >= p.start && t < p.end && km.victim) kills.set(km.killmail_id, km);
        }
        if (list.length < 200 || Date.parse(list[list.length - 1].killmail_time) / 1000 < p.start) break;
        if (page === ZK_PAGES) truncated = true;
      }
    }
  }
  const rows = [];
  for (const km of [...kills.values()].sort((a, b) => a.killmail_id - b.killmail_id)) {
    const atts = km.attackers || [];
    const players = atts.filter((a) => a.character_id);
    if (!players.length) continue;
    const v = km.victim, fin = atts.find((a) => a.final_blow) || atts[0] || {};
    rows.push([km.killmail_id, Math.floor(Date.parse(km.killmail_time) / 1000), km.solar_system_id, v.ship_type_id, Math.round((km.zkb?.totalValue || 0) * 100) / 100,
      v.character_id || null, v.corporation_id || null, v.alliance_id || null,
      players.map((a) => [a.character_id, a.corporation_id || null, a.alliance_id || null, a.ship_type_id || null, a.damage_done || 0]), fin.character_id || 0]);
  }
  rows.sort((a, b) => a[1] - b[1]);
  if (rows.length > 5000) { rows.length = 5000; truncated = true; }
  // 名称：人物、军团、联盟一次最多解析 2000 个
  const ids = [...new Set(rows.flatMap((k) => [k[5], k[6], k[7], ...k[8].flatMap((a) => a.slice(0, 3))]).filter(Boolean))];
  const names = {};
  for (let i = 0; i < ids.length; i += 2000) {
    const r = await ctx.app.resolveNames(ids.slice(i, i + 2000)).catch(() => null);
    r?.names?.forEach((n, id) => { names[id] = n; });
  }
  return { ...local, kills: rows, truncated, dmg_missing: 0, names, zk: true };
}

// 旧击杀的伤害由服务端向 ESI 补，补完前隔一会儿重新取一次，只更新参战玩家名单
let dmgTimer = 0;
function refreshDamage() {
  clearTimeout(dmgTimer);
  const d = BR.data, key = BR.key;
  if (!d?.dmg_missing) return;
  dmgTimer = setTimeout(async () => {
    const shown = () => document.querySelector('[data-br-list], #brPilots');
    if (BR.key !== key || BR.data !== d || !shown()) return;
    let data;
    try {
      data = await ctx.request(`br?systems=${d.systems.join(',')}&start=${d.start}&end=${d.end}`);
      ctx.absorbNames(data.names);
      await ctx.loadTypes([...new Set(data.kills.flatMap((k) => [k[3], ...k[8].map((a) => a[3])]))]);
    } catch { return; }
    if (BR.key !== key || BR.data !== d || !shown()) return;
    BR.data = data;
    summarize();
    redrawLists();
    refreshDamage();
  }, 15000);
}

const partyOf = (corp, alliance) => alliance || corp || 0;

function summarize() {
  const P = new Map();
  const party = (corp, alliance) => {
    const id = partyOf(corp, alliance);
    if (!P.has(id)) P.set(id, { id, kind: alliance ? 'alliance' : 'corporation', pilots: new Set(), kills: new Set(), losses: 0, lost: 0, hostile: new Map(), friendly: new Map() });
    return P.get(id);
  };
  BR.pilotShips = new Map();   // 角色 -> Set(舰船)
  BR.pilotParty = new Map();   // 角色 -> 势力
  BR.pilotStats = new Map();   // 角色 -> { kills: Set(击杀), losses, lost, dmg(造成的伤害) }
  const stat = (char) => { if (!BR.pilotStats.has(char)) BR.pilotStats.set(char, { kills: new Set(), losses: 0, lost: 0, dmg: 0 }); return BR.pilotStats.get(char); };
  const addShip = (char, ship, pid) => {
    if (!char) return;
    BR.pilotParty.set(char, pid);
    if (!ship || PODS.has(ship)) return;
    if (!BR.pilotShips.has(char)) BR.pilotShips.set(char, new Set());
    BR.pilotShips.get(char).add(ship);
  };
  for (const [id, , , ship, value, vChar, vCorp, vAlliance, att] of BR.data.kills) {
    const vp = party(vCorp, vAlliance);
    vp.losses += 1;
    vp.lost += value;
    if (vChar) { vp.pilots.add(vChar); const st = stat(vChar); st.losses += 1; st.lost += value; }
    addShip(vChar, ship, vp.id);
    const atkParties = new Set();
    for (const [char, corp, alliance, aship, dmg] of att) {
      const ap = party(corp, alliance);
      ap.pilots.add(char);
      ap.kills.add(id);
      if (char) { const st = stat(char); st.kills.add(id); if (dmg) st.dmg += dmg; }
      atkParties.add(ap.id);
      addShip(char, aship, ap.id);
    }
    // 攻击关系：攻击者势力与受害者势力敌对；同一击杀里的攻击者势力友好
    for (const a of atkParties) {
      if (a === vp.id) continue;
      const ap = P.get(a);
      ap.hostile.set(vp.id, (ap.hostile.get(vp.id) || 0) + 1);
      vp.hostile.set(a, (vp.hostile.get(a) || 0) + 1);
      for (const b of atkParties) if (b !== a) ap.friendly.set(b, (ap.friendly.get(b) || 0) + 1);
    }
  }
  P.delete(0);
  BR.parties = P;
}

// 自动划分阵营：参与度最高的势力为 A 方；其余按与已分配势力的敌对 / 友好关系依次加入，与双方都无交集的不分配
function autoSides() {
  BR.side.clear();
  const list = [...BR.parties.values()].sort((a, b) => b.pilots.size - a.pilots.size || b.lost - a.lost);
  if (!list.length) return;
  BR.side.set(list[0].id, 'A');
  const score = (p, s) => {
    let v = 0;
    for (const [id, side] of BR.side) {
      if (side !== s || id === p.id) continue;
      v += (p.friendly.get(id) || 0) - 2 * (p.hostile.get(id) || 0);
    }
    return v;
  };
  // 多轮：每轮把与已分配势力关系最明确的势力加入，直到没有可判断的
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const p of list) {
      if (BR.side.get(p.id) && pass === 0) continue;
      const a = score(p, 'A'), b = score(p, 'B');
      let side = null;
      if (a > 0 || b > 0) side = a >= b ? 'A' : 'B';
      else if (a < 0 || b < 0) side = a < b ? 'B' : 'A';
      if (side && BR.side.get(p.id) !== side && !(p.id === list[0].id)) { BR.side.set(p.id, side); changed = true; }
    }
    if (!changed) break;
  }
  // 第三方：对 A、B 两边都下过手（各至少 3 次，且少的一边不低于多的三成）的势力单独算 C 方
  const hostileTo = (p, s) => { let v = 0; for (const [id, n] of p.hostile) if (BR.side.get(id) === s && id !== p.id) v += n; return v; };
  const third = list.filter((p) => p.id !== list[0].id).filter((p) => {
    const a = hostileTo(p, 'A'), b = hostileTo(p, 'B');
    return a >= 3 && b >= 3 && Math.min(a, b) >= 0.3 * Math.max(a, b);
  });
  for (const p of third) BR.side.set(p.id, 'C');
}

function sideStats(s) {
  const st = { pilots: new Set(), parties: [], ships: 0, pods: 0, lost: 0, destroyed: 0, losses: [], fielded: new Map(), lostByType: new Map() };
  for (const p of BR.parties.values()) if (BR.side.get(p.id) === s) { st.parties.push(p); p.pilots.forEach((c) => st.pilots.add(c)); }
  for (const k of BR.data.kills) {
    const vs = BR.side.get(partyOf(k[6], k[7]));
    if (vs === s) {
      st.lost += k[4];
      if (PODS.has(k[3])) st.pods += 1; else { st.ships += 1; st.lostByType.set(k[3], (st.lostByType.get(k[3]) || 0) + 1); }
      st.losses.push(k);
    } else if (vs && k[8].some((a) => BR.side.get(partyOf(a[1], a[2])) === s)) {
      st.destroyed += k[4];
    }
  }
  // 舰船组成：每名飞行员出现过的舰船（同一人换船分别计数，不含太空舱）
  for (const c of st.pilots) for (const t of BR.pilotShips.get(c) || []) st.fielded.set(t, (st.fielded.get(t) || 0) + 1);
  st.parties.sort((a, b) => b.pilots.size - a.pilots.size || b.lost - a.lost);
  st.losses.sort((a, b) => b[4] - a[4]);
  return st;
}

// ---------- 结果渲染 ----------
function renderResult() {
  const d = BR.data;
  const box = $('brResult');
  if (!d.kills.length) {
    const old = d.retention_days && d.start < Date.now() / 1000 - d.retention_days * 86400;   // 0 = 永久保存（国服）
    box.innerHTML = `<p class="kb-empty text-muted">${d.zk ? '没有玩家击杀（zKillboard 上也没有）' : `没有玩家击杀${old ? `（仅存 ${d.retention_days - 1} 天）` : ''}`}</p>`;
    return;
  }
  const sides = sidesUsed();
  const stats = Object.fromEntries(sides.map((s) => [s, sideStats(s)]));
  const A = stats.A, B = stats.B;
  if (!sides.includes(BR.view)) BR.view = 'A';
  const total = d.kills.reduce((s, k) => s + k[4], 0);
  const pilots = new Set([...BR.pilotParty.keys()]).size;
  const unassigned = [...BR.parties.values()].filter((p) => !BR.side.get(p.id)).sort((a, b) => b.pilots.size - a.pilots.size || b.lost - a.lost);
  const sysList = d.systems.map((id) => ctx.kb.systemLabel(id).name).join('、');
  box.innerHTML = `
    <div class="kb-br-summary">
      <div class="kb-br-title">
        <strong>${ctx.app.esc(sysList)}</strong>
        <span class="text-muted">${fmtTime(d.start)} – ${fmtTime(d.end)} ${tzLabel()} · ${d.kills.length} 次击杀 · ${ctx.app.formatNumber(pilots)} 名飞行员 · 总损失 ${ctx.app.formatISK(total)} ISK${d.truncated ? ' · 击杀过多，只统计前 5000 条' : ''}${d.zk ? '<span class="kb-br-zk">超出本站保存期限，数据实时取自 zKillboard（价值为 zKillboard 估值）</span>' : ''}</span>
      </div>
      <div class="kb-br-tools">
        <div class="segmented kb-br-width" role="group" aria-label="宽度">
          <button data-br-narrow="0" class="${BR.narrow ? '' : 'active'}" title="铺满页面宽度">铺满</button>
          <button data-br-narrow="1" class="${BR.narrow ? 'active' : ''}" title="像 zKillboard 那样居中、限宽">窄版</button>
        </div>
        <button class="btn btn-ghost" data-br-auto title="按击杀关系重新推测各方">重新分阵营</button>
        <button class="btn btn-ghost${BR.replay ? ' active' : ''}" data-br-replay title="按击杀邮件的时间点回放这场会战">战局复盘</button>
        <button class="btn btn-ghost" data-br-share>复制链接</button>
        ${ctx.app.openBattleSim ? '<button class="btn btn-ghost" data-br-sim title="按双方实际出场的舰船（装配取击杀记录里最常见的一套）进行战场模拟">战场模拟</button>' : ''}
        <button class="btn btn-primary" data-br-image title="生成战况图片，可下载或复制后分享">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg><span>分享图片</span>
        </button>
      </div>
    </div>
    ${BR.replay ? '<div id="brReplay"></div>' : ''}
    ${sides.length > 2 ? multiHero(sides, stats) : ratioHero(A, B)}
    ${timelineBox()}
    <div class="segmented kb-br-tabs" role="tablist" aria-label="查看">
      <button role="tab" data-br-tab="sides" class="${BR.tab === 'pilots' ? '' : 'active'}">阵营对比</button>
      <button role="tab" data-br-tab="pilots" class="${BR.tab === 'pilots' ? 'active' : ''}">玩家统计</button>
    </div>
    ${BR.tab === 'pilots' ? pilotsView(sides) : `<div class="kb-br-layout-bar">
      <label class="search-box kb-br-psearch"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-br-pq value="${ctx.app.esc(BR.pq)}" placeholder="查玩家：名字或角色 ID" autocomplete="off" spellcheck="false"></label>
      <span class="kb-br-pq-note text-muted" id="brPqNote">${pqNote()}</span>
      <div class="segmented kb-br-switch" role="group" aria-label="查看哪一方">
        ${sides.map((s) => `<button data-br-view="${s}" class="${BR.view === s ? 'active' : ''}">${s} 方</button>`).join('')}
      </div>
    </div>
    <div class="kb-br-cols" data-view="${BR.view}" data-n="${sides.length}">
      ${sides.map((s) => sideColumn(s, stats[s])).join('')}
    </div>
    ${unassigned.length ? `<section class="kb-br-col kb-br-third">
      <h4>未分配 / 第三方<span>${unassigned.length} 个势力</span></h4>
      <div class="kb-br-parties">${unassigned.map((p) => partyRow(p, null)).join('')}</div>
    </section>` : ''}`}
`;
  box.classList.toggle('kb-br-narrow', BR.narrow);
  box.onclick = onResultClick;
  // 查玩家：只重画各方的逐船列表（整页重画会丢掉输入框的焦点）
  box.oninput = (e) => { if (e.target.matches('[data-br-pq]')) { BR.pq = e.target.value; BR.ptAll = false; redrawLists(); } };
  if (BR.replay) mountReplay($('brReplay'), replayModel(sides, stats)); else stopReplay();
  drawTimeline();
  observeChart();
}

// 损失对比：以双方 ISK 损失比为主体，下面是 ISK 占比条与舰船 / 人数等对比条
// 损失比、胜负判断与占比（页面与分享图片共用）
function ratioInfo(A, B) {
  const total = A.lost + B.lost;
  const pa = total ? A.lost / total : 0.5;
  const fmtR = (v) => String(Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)));
  // 损失比：较小的一方记为 1
  const ratio = !A.lost || !B.lost ? null : A.lost >= B.lost ? [fmtR(A.lost / B.lost), '1'] : ['1', fmtR(B.lost / A.lost)];
  const big = Math.max(A.lost, B.lost) / Math.max(1, Math.min(A.lost, B.lost));
  const winner = A.lost < B.lost ? 'A' : 'B';
  const decided = total && big >= 1.15;
  const verdict = !total ? '双方都没有损失'
    : !A.lost || !B.lost ? `${winner} 方零损失`
    : big < 1.15 ? '势均力敌'
    : `${winner} 方占优 · 对方损失是其 ${fmtR(big)} 倍`;
  const effW = winner === 'A' ? 1 - pa : pa;
  return { total, pa, ratio, winner: decided ? winner : null, effWinner: winner, verdict, effText: total ? `${winner} 方 ISK 效率 ${(effW * 100).toFixed(1)}%` : '' , effW };
}

function ratioHero(A, B) {
  const isk = ctx.app.formatISK, num = ctx.app.formatNumber;
  const { total, pa, ratio, winner, effWinner, verdict, effW } = ratioInfo(A, B);
  const row = (label, a, b, fa = num) => {
    const t = a + b;
    const w = t ? a / t * 100 : 50;
    return `<div class="kb-br-cmp">
      <b class="a">${fa(a)}</b>
      <div class="kb-br-cmp-bar"><i class="a" style="width:${w.toFixed(1)}%"></i><i class="b" style="width:${(100 - w).toFixed(1)}%"></i><span>${label}</span></div>
      <b class="b">${fa(b)}</b>
    </div>`;
  };
  const perPilot = (st) => (st.pilots.size ? st.lost / st.pilots.size : 0);
  return `<section class="kb-br-ratio">
    <div class="kb-br-ratio-top">
      <div class="kb-br-ratio-side side-a">
        <div class="kb-br-side-name"><i class="kb-br-badge">A</i>A 方<small>${A.parties.length} 个势力 · ${num(A.pilots.size)} 人</small></div>
        <div class="kb-br-ratio-isk">${isk(A.lost)}<small>ISK 损失</small></div>
      </div>
      <div class="kb-br-ratio-mid">
        <span class="kb-br-ratio-label">损失比</span>
        <div class="kb-br-ratio-num">${ratio ? `<b class="a">${ratio[0]}</b><i>:</i><b class="b">${ratio[1]}</b>` : '<b>—</b>'}</div>
        <span class="kb-br-verdict${winner ? ' win-' + winner.toLowerCase() : ''}">${verdict}</span>
      </div>
      <div class="kb-br-ratio-side side-b">
        <div class="kb-br-side-name"><small>${B.parties.length} 个势力 · ${num(B.pilots.size)} 人</small>B 方<i class="kb-br-badge">B</i></div>
        <div class="kb-br-ratio-isk">${isk(B.lost)}<small>ISK 损失</small></div>
      </div>
    </div>
    <div class="kb-br-share" title="双方 ISK 损失占比">
      <i class="a" style="width:${(pa * 100).toFixed(2)}%"><span>${(pa * 100).toFixed(1)}%</span></i>
      <i class="b" style="width:${((1 - pa) * 100).toFixed(2)}%"><span>${((1 - pa) * 100).toFixed(1)}%</span></i>
    </div>
    <div class="kb-br-share-note"><span>ISK 损失占比</span>${total ? `<span>${effWinner} 方 ISK 效率 <b>${(effW * 100).toFixed(1)}%</b></span>` : ''}</div>
    <div class="kb-br-cmps">
      ${row('舰船损失', A.ships, B.ships)}
      ${A.pods + B.pods ? row('太空舱', A.pods, B.pods) : ''}
      ${row('参战人数', A.pilots.size, B.pilots.size)}
      ${row('人均损失', perPilot(A), perPilot(B), isk)}
    </div>
  </section>`;
}

// 三方及以上：每方一张卡（损失、击毁、效率），下面是各方 ISK 损失占比
function multiHero(sides, stats) {
  const isk = ctx.app.formatISK, num = ctx.app.formatNumber;
  const total = sides.reduce((t, s) => t + stats[s].lost, 0);
  const card = (s) => {
    const st = stats[s];
    const eff = st.destroyed + st.lost ? st.destroyed / (st.destroyed + st.lost) : 0;
    return `<div class="kb-br-mside side-${s.toLowerCase()}">
      <div class="kb-br-side-name"><i class="kb-br-badge">${s}</i>${s} 方<small>${st.parties.length} 个势力 · ${num(st.pilots.size)} 人</small></div>
      <div class="kb-br-ratio-isk">${isk(st.lost)}<small>ISK 损失</small></div>
      <div class="kb-br-mstats"><span>击毁<b>${isk(st.destroyed)}</b></span><span>舰船损失<b>${num(st.ships)}</b></span><span>ISK 效率<b>${st.destroyed + st.lost ? (eff * 100).toFixed(1) + '%' : '—'}</b></span></div>
    </div>`;
  };
  return `<section class="kb-br-ratio kb-br-multi">
    <div class="kb-br-mcards" style="--n:${sides.length}">${sides.map(card).join('')}</div>
    <div class="kb-br-share kb-br-mshare" title="各方 ISK 损失占比">${sides.map((s) => {
      const w = total ? stats[s].lost / total : 1 / sides.length;
      return w ? `<i class="side-${s.toLowerCase()}" style="width:${(w * 100).toFixed(2)}%">${w >= 0.06 ? `<span>${(w * 100).toFixed(1)}%</span>` : ''}</i>` : '';
    }).join('')}</div>
    <div class="kb-br-share-note"><span>ISK 损失占比</span></div>
  </section>`;
}

function partyRow(p, side) {
  // 可移到的阵营：现有各方 + 下一个新的一方（最多 D 方）
  const sides = sidesUsed();
  if (sides.length < SIDE_ALL.length) sides.push(SIDE_ALL[sides.length]);
  const move = sides.filter((s) => s !== side);
  return `<div class="kb-br-party">
    <img src="${ctx.avatar(p.kind, p.id, 32)}" alt="" width="28" height="28" loading="lazy">
    <div class="kb-br-party-main">${ctx.entityLink(p.kind, p.id)}<small>${p.pilots.size} 人 · 参与击杀 ${p.kills.size} · 损失 ${p.losses}（${ctx.app.formatISK(p.lost)}）</small></div>
    <div class="kb-br-move">${move.map((m) => `<button class="m-${m.toLowerCase()}" data-br-move="${p.id}:${m}" title="移到 ${m} 方">${m}</button>`).join('')}${side ? `<button data-br-move="${p.id}:-" title="移出（不计入任何一方）">×</button>` : ''}</div>
  </div>`;
}

// 各方一列：标题、数字、势力（可移到别的一方）、舰船组成、逐船列表。宽屏下各列用 subgrid 逐块对齐，所以每列固定 8 块
function sideColumn(s, st) {
  const { esc, formatISK, formatNumber } = ctx.app;
  const fleet = [...st.fielded].sort((a, b) => b[1] - a[1]).map(([t, n]) => {
    const lost = st.lostByType.get(t) || 0;
    return `<span class="kb-br-fship" title="${esc(ctx.typeName(t))} · 出场 ${n}${lost ? ` · 损失 ${lost}` : ''}"><img src="${ctx.IMG(`types/${t}/icon`, 32)}" alt="" width="24" height="24" loading="lazy"><b>${n}</b>${lost ? `<em>-${lost}</em>` : ''}</span>`;
  }).join('');
  const eff = st.destroyed + st.lost ? (st.destroyed / (st.destroyed + st.lost) * 100).toFixed(1) + '%' : '—';
  return `<section class="kb-br-col side-${s.toLowerCase()}">
    <h4 class="kb-br-col-title"><i class="kb-br-badge">${s}</i>${s} 方<span>${st.parties.length} 个势力</span></h4>
    <div class="kb-zk-stats">
      <span>ISK 损失<b>${formatISK(st.lost)}</b></span><span>舰船损失<b>${formatNumber(st.ships)}</b></span>
      <span>飞行员<b>${formatNumber(st.pilots.size)}</b></span><span>ISK 效率<b>${eff}</b></span>
    </div>
    <div class="kb-br-parties">${st.parties.map((p) => partyRow(p, s)).join('') || '<p class="text-muted kb-br-none">暂无势力</p>'}</div>
    <h4>舰船组成<span>出场 / 损失</span></h4>
    <div class="kb-br-fleet">${fleet || '<p class="text-muted kb-br-none">无</p>'}</div>
    <h4>飞行员与舰船</h4>
    <div class="kb-zk-list" data-br-list="${s}">${zkList(s)}</div>
    <div data-br-more="${s}">${zkMore(s)}</div>
  </section>`;
}

// ---------- 逐船列表（zKill 战报式） ----------
// 每名飞行员开过的每艘船一行（同一人同一船型损失两次算两行）；被击毁的标红、显示损失价值，没被击毁的显示参与击杀数与伤害。
// 按舰船级别（旗舰在前）、同船型放一起排序；太空舱损失紧跟在本人的船后面。查玩家时只列匹配的飞行员
let zkCache = null;   // { data, side 快照, bySide: { A: [行…] } }
function zkEntries() {
  const E = new Map();
  const get = (key, char, ship) => {
    if (!E.has(key)) E.set(key, { char, ship, party: 0, corp: 0, alliance: 0, kill: 0, value: 0, t: 0, kills: 0, dmg: 0 });
    return E.get(key);
  };
  const kills = [...BR.data.kills].sort((a, b) => a[1] - b[1]);
  for (const [id, t, , ship, value, vChar, vCorp, vAlliance, att] of kills) {
    let e;
    if (vChar) {
      e = get(vChar + ':' + ship, vChar, ship);
      if (e.kill) e = get(vChar + ':' + ship + ':' + id, vChar, ship);
    } else e = get('k' + id, 0, ship);   // 建筑等没有飞行员的损失
    Object.assign(e, { party: partyOf(vCorp, vAlliance), corp: vCorp, alliance: vAlliance, kill: id, value, t });
    for (const [char, corp, alliance, aship, dmg] of att) {
      if (!char || !aship || PODS.has(aship)) continue;
      const a = get(char + ':' + aship, char, aship);
      if (!a.party) Object.assign(a, { party: partyOf(corp, alliance), corp, alliance });
      a.kills += 1;
      a.dmg += dmg || 0;
    }
  }
  return [...E.values()];
}
function zkRows() {
  const sig = [...BR.side].join();
  if (zkCache?.data === BR.data && zkCache.sig === sig) return zkCache.bySide;
  const cls = new Map();
  const classOf = (t) => { if (!cls.has(t)) cls.set(t, ctx.app.shipClass?.(t) || [999, '']); return cls.get(t); };
  const bySide = {};
  for (const e of zkEntries()) {
    const s = BR.side.get(e.party);
    if (s) (bySide[s] = bySide[s] || []).push(e);
  }
  for (const s of Object.keys(bySide)) {
    const list = bySide[s];
    const ships = list.filter((e) => !PODS.has(e.ship));
    const hull = new Map();
    ships.forEach((e) => hull.set(e.ship, (hull.get(e.ship) || 0) + 1));
    ships.sort((a, b) => classOf(a.ship)[0] - classOf(b.ship)[0] || hull.get(b.ship) - hull.get(a.ship) || a.ship - b.ship ||
      Boolean(b.kill) - Boolean(a.kill) || b.value - a.value || b.kills - a.kills);
    const podOf = new Map();
    list.filter((e) => PODS.has(e.ship)).forEach((p) => { if (!podOf.has(p.char)) podOf.set(p.char, []); podOf.get(p.char).push(p); });
    const ordered = [];
    for (const e of ships) {
      ordered.push({ ...e, cls: classOf(e.ship)[1] });
      const mine = podOf.get(e.char);
      if (mine) { mine.forEach((p) => ordered.push({ ...p, under: true })); podOf.delete(e.char); }
    }
    for (const rest of podOf.values()) ordered.push(...rest);
    bySide[s] = ordered;
  }
  zkCache = { data: BR.data, sig, bySide };
  return bySide;
}
function zkMatch() {
  const q = BR.pq.trim(), ql = q.toLowerCase(), qid = /^\d{5,}$/.test(q) ? Number(q) : 0;
  return q ? (e) => e.char && (e.char === qid || String(ctx.partyName(e.char) || '').toLowerCase().includes(ql)) : null;
}
const zkFiltered = (s) => { const m = zkMatch(), list = zkRows()[s] || []; return m ? list.filter(m) : list; };
function zkList(s) {
  const { esc, formatISK } = ctx.app;
  const list = zkFiltered(s);
  if (!list.length) return `<p class="text-muted kb-br-none">${BR.pq.trim() ? '这一方没有匹配的玩家' : '没有舰船'}</p>`;
  const shown = BR.zkAll || BR.pq.trim() ? list : list.slice(0, ZK_LIMIT);
  let last = null;
  return shown.map((e) => {
    const head = e.cls && e.cls !== last ? `<div class="kb-zk-class">${esc(e.cls)}</div>` : '';
    if (e.cls) last = e.cls;
    const who = e.char ? ctx.entityLink('character', e.char) : '';
    const val = e.kill ? `${e.value ? `<b>${formatISK(e.value)}</b>` : ''}<small>${fmtClock(e.t)}</small>`
      : `${e.kills ? `<span>击杀 ${e.kills}</span>` : ''}${e.dmg ? `<small>伤害 ${fmtDmg(e.dmg)}</small>` : ''}`;
    return `${head}<div class="kb-zk-row${e.kill ? ' lost' : ''}${e.under ? ' pod' : ''}"${e.kill ? ` data-kill="${e.kill}" tabindex="0"` : ''}>
      <img class="kb-zk-ship" src="${ctx.IMG(`types/${e.ship}/icon`, 32)}" alt="" width="32" height="32" loading="lazy">
      <span class="kb-zk-main"><span class="kb-zk-l1">${who}<span class="kb-zk-hull">${esc(ctx.typeName(e.ship))}</span></span>
        <small translate="no">${orgLine(e.corp, e.alliance)}</small></span>
      <span class="kb-zk-val">${val}</span>
    </div>`;
  }).join('');
}
// 所属：军团 · 联盟（各带图标；没有联盟只写军团）
function orgLine(corp, alliance) {
  const { esc } = ctx.app;
  const one = (kind, id) => `<span class="kb-zk-org"><img src="${ctx.avatar(kind, id, 32)}" alt="" width="14" height="14" loading="lazy"><span>${esc(ctx.partyName(id))}</span></span>`;
  return (corp ? one('corporation', corp) : '') + (alliance ? one('alliance', alliance) : '');
}
function zkMore(s) {
  const n = zkFiltered(s).length;
  return !BR.zkAll && !BR.pq.trim() && n > ZK_LIMIT ? `<button class="btn btn-ghost btn-sm kb-br-pmore" data-br-zkall>显示全部 ${ctx.app.formatNumber(n)} 行</button>` : '';
}
// 查玩家的结果说明：这场战斗里没有时，角色 ID 给出人物页链接
function pqNote() {
  const q = BR.pq.trim();
  if (!q) return '';
  const m = zkMatch();
  const n = new Set(Object.values(zkRows()).flat().filter(m).map((e) => e.char)).size;
  if (n) return `找到 ${n} 名玩家`;
  const qid = /^\d{5,}$/.test(q) ? Number(q) : 0;
  return `这场战斗里没有「${ctx.app.esc(q)}」${qid ? ` · <a class="kb-link" href="#kb/character/${qid}">查看角色 ${qid} 的击杀记录</a>` : ''}`;
}
function redrawLists() {
  const pt = $('brPilots');
  if (pt) pt.innerHTML = pilotTable();
  document.querySelectorAll('[data-br-list]').forEach((el) => { el.innerHTML = zkList(el.dataset.brList); });
  document.querySelectorAll('[data-br-more]').forEach((el) => { el.innerHTML = zkMore(el.dataset.brMore); });
  const note = $('brPqNote');
  if (note) note.innerHTML = pqNote();
}
// ---------- 玩家统计（战况走势下面切换） ----------
// 每名飞行员一行：参与击杀（每次击杀只算一次）、最后一击、击杀价值（参与的击杀的总价值）、损失（含太空舱）与损失价值、
// ISK 效率、造成伤害（攻击者伤害之和）、承受伤害（自己被击毁时来自玩家的伤害）。击杀邮件不记录远程维修，所以没有治疗量。
// 所属与阵营按最后一次出现时的军团 / 联盟
let ptCache = null;
const hasFinalBlow = () => BR.data.kills.some((k) => k.length > 9);
function pilotRows() {
  if (ptCache?.data === BR.data) return ptCache.rows;
  const P = new Map();
  const get = (char) => {
    if (!P.has(char)) P.set(char, { char, corp: 0, alliance: 0, t: -1, kills: 0, fb: 0, killed: 0, losses: 0, lost: 0, dmg: 0, taken: 0, ships: new Map() });
    return P.get(char);
  };
  const seen = (r, t, corp, alliance, ship) => {
    if (t >= r.t) Object.assign(r, { t, corp, alliance });
    if (ship && !PODS.has(ship)) r.ships.set(ship, (r.ships.get(ship) || 0) + 1);
  };
  for (const [id, t, , ship, value, vChar, vCorp, vAlliance, att, fChar] of BR.data.kills) {
    const done = new Set();
    let taken = 0;
    for (const [char, corp, alliance, aship, dmg] of att) {
      taken += dmg || 0;
      if (!char) continue;
      const r = get(char);
      seen(r, t, corp, alliance, aship);
      r.dmg += dmg || 0;
      if (done.has(char)) continue;
      done.add(char);
      r.kills += 1;
      r.killed += value;
      if (fChar && fChar === char) r.fb += 1;
    }
    if (vChar) {
      const r = get(vChar);
      seen(r, t, vCorp, vAlliance, ship);
      r.losses += 1;
      r.lost += value;
      r.taken += taken;
    }
  }
  const rows = [...P.values()].map((r) => ({ ...r, party: partyOf(r.corp, r.alliance), eff: r.killed + r.lost ? r.killed / (r.killed + r.lost) : -1, ships: [...r.ships].sort((a, b) => b[1] - a[1]).map(([t]) => t) }));
  ptCache = { data: BR.data, rows };
  return rows;
}
const PT_COLS = [['name', '飞行员', ''], ['side', '阵营', ''], ['ships', '舰船', 'kb-hide-sm'], ['kills', '击杀', 'num'], ['fb', '最后一击', 'num'], ['killed', '击杀价值', 'num'],
  ['losses', '损失', 'num'], ['lost', '损失价值', 'num'], ['eff', 'ISK 效率', 'num'], ['dmg', '造成伤害', 'num'], ['taken', '承受伤害', 'num']];
function pilotsView(sides) {
  return `<div class="kb-br-layout-bar">
      <label class="search-box kb-br-psearch"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-br-pq value="${ctx.app.esc(BR.pq)}" placeholder="查玩家、军团或联盟" autocomplete="off" spellcheck="false"></label>
      <div class="segmented kb-br-pside" role="group" aria-label="只看哪一方">
        ${['all', ...sides, '-'].map((s) => `<button data-br-pside="${s}" class="${BR.pside === s ? 'active' : ''}">${s === 'all' ? '全部' : s === '-' ? '未分配' : s + ' 方'}</button>`).join('')}
      </div>
    </div>
    <div class="kb-br-ptable" id="brPilots">${pilotTable()}</div>`;
}
function pilotTable() {
  const { esc, formatISK, formatNumber } = ctx.app;
  const fb = hasFinalBlow();
  const cols = PT_COLS.filter(([k]) => fb || k !== 'fb');
  const q = BR.pq.trim(), ql = q.toLowerCase(), qid = /^\d{5,}$/.test(q) ? Number(q) : 0;
  const sideOf = (r) => BR.side.get(r.party) || '';
  const has = (id) => String(ctx.partyName(id) || '').toLowerCase().includes(ql);
  let list = pilotRows().filter((r) => (BR.pside === 'all' || (BR.pside === '-' ? !sideOf(r) : sideOf(r) === BR.pside)) &&
    (!q || r.char === qid || has(r.char) || (r.corp && has(r.corp)) || (r.alliance && has(r.alliance))));
  const { key, dir } = BR.psort;
  const val = (r) => key === 'name' ? String(ctx.partyName(r.char) || '') : key === 'side' ? sideOf(r) || '~' : key === 'ships' ? r.ships.length : r[key];
  list = list.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y, 'zh-CN') : x - y;
    return (dir === 'asc' ? c : -c) || b.dmg - a.dmg || a.char - b.char;
  });
  if (!list.length) return `<p class="text-muted kb-br-none">${q ? '没有匹配的玩家' : '没有玩家'}</p>`;
  const shown = BR.ptAll ? list : list.slice(0, ZK_LIMIT);
  const n0 = (v, f) => (v ? f(v) : '<span class="text-muted">0</span>');
  const ships = (r) => r.ships.slice(0, 4).map((t) => `<img src="${ctx.IMG(`types/${t}/icon`, 32)}" alt="" width="22" height="22" loading="lazy" title="${esc(ctx.typeName(t))}">`).join('') + (r.ships.length > 4 ? `<small>+${r.ships.length - 4}</small>` : '');
  const cell = {
    name: (r) => `<td><span class="kb-pt-who"><img src="${ctx.avatar('character', r.char, 32)}" alt="" width="28" height="28" loading="lazy"><span class="kb-zk-main">${ctx.entityLink('character', r.char)}<small translate="no">${orgLine(r.corp, r.alliance)}</small></span></span></td>`,
    side: (r) => `<td>${sideOf(r) ? `<i class="kb-br-badge side-${sideOf(r).toLowerCase()}">${sideOf(r)}</i>` : '<span class="text-muted">—</span>'}</td>`,
    ships: (r) => `<td class="kb-hide-sm"><span class="kb-pt-ships">${ships(r)}</span></td>`,
    kills: (r) => `<td class="num">${n0(r.kills, formatNumber)}</td>`,
    fb: (r) => `<td class="num">${n0(r.fb, formatNumber)}</td>`,
    killed: (r) => `<td class="num up">${n0(r.killed, formatISK)}</td>`,
    losses: (r) => `<td class="num">${n0(r.losses, formatNumber)}</td>`,
    lost: (r) => `<td class="num down">${n0(r.lost, formatISK)}</td>`,
    eff: (r) => `<td class="num">${r.eff < 0 ? '—' : (r.eff * 100).toFixed(1) + '%'}</td>`,
    dmg: (r) => `<td class="num">${n0(r.dmg, fmtDmg)}</td>`,
    taken: (r) => `<td class="num">${n0(r.taken, fmtDmg)}</td>`
  };
  return `<div class="table-scroll"><table class="kb-rank-table kb-pt-table"><thead><tr>
      ${cols.map(([k, l, c]) => `<th class="sortable ${c}${k === key ? ' sorted' : ''}" data-br-psort="${k}" data-dir="${k === key ? dir : ''}" tabindex="0">${l}</th>`).join('')}
    </tr></thead><tbody>${shown.map((r) => `<tr>${cols.map(([k]) => cell[k](r)).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="kb-pt-foot"><span class="text-muted"><span>${formatNumber(list.length)} 名玩家</span>${BR.data.dmg_missing ? '<span>部分伤害还在补全</span>' : ''}<span>击杀邮件不记录远程维修，没有治疗量</span></span>
      ${list.length > shown.length ? `<button class="btn btn-ghost btn-sm" data-br-ptall>显示全部 ${formatNumber(list.length)} 名</button>` : ''}</div>`;
}

// 伤害：一百万以下写全数，以上缩写
const fmtDmg = (v) => (v >= 1e6 ? ctx.app.formatISK(v) : ctx.app.formatNumber(Math.round(v)));

// ---------- 战况走势图 ----------
// 两种视图：累计损失（阶梯线 + 面积 + 最贵损失标记）与损失分布（按时间分段，A 方向上、B 方向下）
const NICE_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720];
const niceStep = (span, n) => NICE_MIN.find((m) => span / (m * 60) <= n) * 60 || 1440 * 60;
// 纵轴取整：约 n 格，每格 1 / 2 / 2.5 / 5 × 10 的幂，上限略高于最大值（分享图片共用）
export function niceAxis(v, n = 4) {
  const raw = Math.max(v, 1) * 1.04 / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
  return { step, max: step * Math.ceil(Math.max(v, 1) * 1.04 / step) };
}
// 刻度上的 ISK：去掉多余的 0（10.00B → 10B）
const axisIsk = (v) => (v ? ctx.app.formatISK(v, true).replace(/\.?0+(?=[KMBT]?$)/, '') : '0');

function timelineBox() {
  return `<div class="kb-br-chart" id="brChart">
    <div class="kb-br-chart-head">
      <h4>战况走势</h4>
      <div class="kb-br-legend" id="brLegend"></div>
      <div class="segmented" role="group" aria-label="图表类型">
        <button data-br-chart="cum" class="${BR.chart !== 'bar' ? 'active' : ''}">累计损失</button>
        <button data-br-chart="bar" class="${BR.chart === 'bar' ? 'active' : ''}">损失分布</button>
      </div>
    </div>
    <div class="kb-br-plot" id="brPlot"><svg></svg><div class="kb-br-tip" id="brTip" hidden></div></div>
  </div>`;
}

function chartData() {
  const kills = BR.data.kills.filter((k) => BR.side.get(partyOf(k[6], k[7])));
  const t0 = BR.data.kills[0][1];
  const t1 = Math.max(BR.data.kills[BR.data.kills.length - 1][1], t0 + 300);
  const sides = sidesUsed();
  const cum = Object.fromEntries(sides.map((s) => [s, [[t0, 0]]]));
  const acc = Object.fromEntries(sides.map((s) => [s, 0])), cnt = { ...acc };
  for (const k of kills) {
    const s = BR.side.get(partyOf(k[6], k[7]));
    acc[s] += k[4];
    cnt[s] += 1;
    cum[s].push([k[1], acc[s], k]);
  }
  return { kills, t0, t1, cum, acc, cnt, sides };
}

function drawTimeline() {
  const plot = $('brPlot');
  if (!plot || !BR.data?.kills.length) return;
  const cd = chartData();
  const { t0, t1, cum, acc, sides } = cd;
  const lc = (s) => s.toLowerCase();
  $('brLegend').innerHTML = sides.map((s) => `<span class="${lc(s)}"><i></i>${s} 方损失 <b>${ctx.app.formatISK(acc[s])}</b></span>`).join('');
  const W = Math.max(280, plot.clientWidth), H = W < 600 ? 190 : 230;
  const L = 54, R = 14, T = 18, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const x = (t) => L + (t - t0) / (t1 - t0) * iw;
  const esc = ctx.app.esc, isk = ctx.app.formatISK;
  let body = '';
  // 时间刻度
  const step = niceStep(t1 - t0, Math.max(3, Math.floor(iw / 90)));
  let xt = '';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    xt += `<text class="ax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmtClock(t)}</text>`;
  }
  const mode = BR.chart === 'bar' ? 'bar' : 'cum';
  let hover;
  if (mode === 'cum') {
    const ax = niceAxis(Math.max(...sides.map((s) => acc[s])));
    const y = (v) => T + ih - v / ax.max * ih;
    let yt = '';
    for (let v = 0; v <= ax.max + ax.step / 2; v += ax.step) {
      yt += `<line class="grid${v ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${axisIsk(v)}</text>`;
    }
    // 折线连接每次损失后的累计值（不画阶梯，曲线更顺），最后延伸到结束时间
    const line = (pts) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('') + `L${x(t1).toFixed(1)},${y(pts[pts.length - 1][1]).toFixed(1)}`;
    const area = (pts) => line(pts) + `L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
    body = `<defs>${sides.map((s) => `<linearGradient id="brG${lc(s)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--br-${lc(s)})" stop-opacity=".18"/><stop offset=".75" stop-color="var(--br-${lc(s)})" stop-opacity="0"/></linearGradient>`).join('')}</defs>${yt}${xt}` +
      sides.map((s) => `<path d="${area(cum[s])}" fill="url(#brG${lc(s)})"/>`).join('') +
      sides.map((s) => `<path class="ln ${lc(s)}" d="${line(cum[s])}"/>`).join('');
    // 最贵的几次损失标记在曲线上
    const big = sides.flatMap((s) => cum[s].slice(1).map((p) => [...p, lc(s)])).sort((p, q) => q[2][4] - p[2][4]).slice(0, 6);
    body += big.map(([t, v, k, c]) => `<circle class="mk ${c}" cx="${x(t)}" cy="${y(v)}" r="4.5" data-kill="${k[0]}"><title>${esc(ctx.typeName(k[3]))} · ${isk(k[4])} ISK · ${fmtClock(t)}</title></circle>`).join('');
    // 末端：圆点 + 累计值，标在线上方；从最低的一条开始，和下面的标签靠得太近就再往上挪
    const ends = sides.map((s) => ({ s, v: acc[s], y: y(acc[s]) })).sort((p, q) => p.v - q.v);
    let prev = Infinity;
    body += ends.map((e) => {
      const ty = Math.min(e.y - 9, prev - 15);
      prev = ty;
      return `<circle class="end ${lc(e.s)}" cx="${x(t1)}" cy="${e.y}" r="4"/><text class="endv ${lc(e.s)}" x="${x(t1) - 10}" y="${ty}" text-anchor="end">${isk(e.v)}</text>`;
    }).join('');
    const at = (pts, t) => { let v = 0; for (const p of pts) { if (p[0] > t) break; v = p[1]; } return v; };
    hover = (t) => {
      const vs = sides.map((s) => at(cum[s], t));
      return { x: x(t), dots: vs.map(y), html: `<b>${fmtClock(t)}</b>` + sides.map((s, i) => `<span class="${lc(s)}">${s} 方累计 ${isk(vs[i])}</span>`).join('') };
    };
  } else {
    const size = niceStep(t1 - t0, 48);
    const b0 = Math.floor(t0 / size) * size;
    const n = Math.floor((t1 - b0) / size) + 1;
    const bins = Array.from({ length: n }, (_, i) => ({ t: b0 + i * size, v: {}, c: {} }));
    for (const k of cd.kills) {
      const s = BR.side.get(partyOf(k[6], k[7]));
      const bin = bins[Math.floor((k[1] - b0) / size)];
      bin.v[s] = (bin.v[s] || 0) + k[4];
      bin.c[s] = (bin.c[s] || 0) + 1;
    }
    const xb = (t) => L + (t - b0) / (n * size) * iw;
    const bw = Math.max(1, iw / n - (iw / n > 6 ? 2 : 0.5));
    let yt = '';
    if (sides.length === 2) {
      // 两方：A 方向上、B 方向下
      const max = Math.max(...bins.map((b) => Math.max(b.v.A || 0, b.v.B || 0)), 1) * 1.1;
      const mid = T + ih / 2;
      const yh = (v) => v / max * (ih / 2);
      yt = `<line class="grid base" x1="${L}" x2="${L + iw}" y1="${mid}" y2="${mid}"/>`;
      for (const f of [0.45, 0.9]) {
        const v = max * f;
        yt += `<line class="grid" x1="${L}" x2="${L + iw}" y1="${mid - yh(v)}" y2="${mid - yh(v)}"/><line class="grid" x1="${L}" x2="${L + iw}" y1="${mid + yh(v)}" y2="${mid + yh(v)}"/>`;
        yt += `<text class="ax" x="${L - 8}" y="${mid - yh(v) + 4}" text-anchor="end">${isk(v)}</text><text class="ax" x="${L - 8}" y="${mid + yh(v) + 4}" text-anchor="end">${isk(v)}</text>`;
      }
      body = bins.map((b) => `${b.v.A ? `<rect class="bar a" x="${xb(b.t) + 1}" y="${mid - yh(b.v.A)}" width="${bw}" height="${yh(b.v.A)}" rx="1.5"/>` : ''}${b.v.B ? `<rect class="bar b" x="${xb(b.t) + 1}" y="${mid}" width="${bw}" height="${yh(b.v.B)}" rx="1.5"/>` : ''}`).join('') +
        `<text class="ax side a" x="${L + 6}" y="${T + 10}">A 方损失 ↑</text><text class="ax side b" x="${L + 6}" y="${T + ih - 4}">B 方损失 ↓</text>`;
    } else {
      // 三方及以上：各方损失向上叠加
      const ax = niceAxis(Math.max(...bins.map((b) => sides.reduce((t, s) => t + (b.v[s] || 0), 0)), 1));
      const yv = (v) => T + ih - v / ax.max * ih;
      for (let v = 0; v <= ax.max + ax.step / 2; v += ax.step) {
        yt += `<line class="grid${v ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${yv(v)}" y2="${yv(v)}"/><text class="ax" x="${L - 8}" y="${yv(v) + 4}" text-anchor="end">${axisIsk(v)}</text>`;
      }
      body = bins.map((b) => {
        let base = 0;
        return sides.map((s) => {
          const v = b.v[s] || 0;
          if (!v) return '';
          const r = `<rect class="bar ${lc(s)}" x="${xb(b.t) + 1}" y="${yv(base + v)}" width="${bw}" height="${yv(base) - yv(base + v)}"/>`;
          base += v;
          return r;
        }).join('');
      }).join('');
    }
    xt = '';
    const xs = niceStep(n * size, Math.max(3, Math.floor(iw / 90)));
    for (let t = Math.ceil(b0 / xs) * xs; t <= b0 + n * size; t += xs) xt += `<text class="ax" x="${xb(t)}" y="${H - 8}" text-anchor="middle">${fmtClock(t)}</text>`;
    body = `${yt}${xt}` + body;
    hover = (t) => {
      const b = bins[Math.min(n - 1, Math.max(0, Math.floor((t - b0) / size)))];
      return { x: xb(b.t) + 1 + bw / 2, html: `<b>${fmtClock(b.t)} – ${fmtClock(b.t + size)}</b>` + sides.map((s) => `<span class="${lc(s)}">${s} 方损失 ${isk(b.v[s] || 0)}（${b.c[s] || 0} 艘）</span>`).join('') };
    };
  }
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  // 悬停层放在最底下（其余元素不接收鼠标事件），损失标记在最上层可点击打开详情
  svg.innerHTML = `<rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>` + body + `<line class="cross" id="brCross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>` +
    sides.map((s) => `<circle class="hv ${lc(s)}" r="4" visibility="hidden"/>`).join('');
  const tip = $('brTip'), cross = svg.querySelector('#brCross'), hv = svg.querySelectorAll('.hv');
  const hit = svg.querySelector('.hit');
  hit.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = t0 + (px - L) / iw * (t1 - t0);
    const h = hover(Math.min(t1, Math.max(t0, t)));
    cross.setAttribute('x1', h.x); cross.setAttribute('x2', h.x); cross.setAttribute('visibility', 'visible');
    // 累计图：每条线上各一个跟随的圆点
    hv.forEach((c, i) => { if (h.dots) { c.setAttribute('cx', h.x); c.setAttribute('cy', h.dots[i]); } c.setAttribute('visibility', h.dots ? 'visible' : 'hidden'); });
    tip.innerHTML = h.html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(W - tw - 4, Math.max(4, h.x + 12 + tw > W ? h.x - tw - 12 : h.x + 12)) + 'px';
    tip.style.top = T + 4 + 'px';
  };
  hit.onmouseleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hv.forEach((c) => c.setAttribute('visibility', 'hidden')); };
}

// 容器宽度变化时重绘
let chartObserver = null;
function observeChart() {
  if (!window.ResizeObserver) return;
  chartObserver?.disconnect();
  let w = 0;
  chartObserver = new ResizeObserver(([e]) => {
    const nw = Math.round(e.contentRect.width);
    if (nw && nw !== w) { w = nw; drawTimeline(); }
  });
  chartObserver.observe($('brPlot'));
}

function onResultClick(e) {
  const el = (sel) => e.target.closest(sel);
  let x;
  if ((x = el('[data-br-move]'))) {
    const [id, side] = x.dataset.brMove.split(':');
    if (side === '-') BR.side.delete(Number(id)); else BR.side.set(Number(id), side);
    compactSides();
    history.replaceState(null, '', hashFor());
    renderResult();
    return;
  }
  if (el('[data-br-auto]')) { autoSides(); history.replaceState(null, '', hashFor()); renderResult(); return; }
  if (el('[data-br-image]')) { shareImage(); return; }
  if (el('[data-br-sim]')) { openSim(); return; }
  if (el('[data-br-replay]') || el('[data-br-replay-close]')) {
    BR.replay = !BR.replay;
    renderResult();
    if (BR.replay) $('brReplay')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (el('[data-br-share]')) { ctx.app.copyText(location.origin + location.pathname + hashFor(), '战场统计链接已复制'); return; }
  if ((x = el('[data-br-view]'))) { BR.view = x.dataset.brView; renderResult(); return; }
  if (el('[data-br-zkall]')) { BR.zkAll = true; redrawLists(); return; }
  if ((x = el('[data-br-tab]'))) { if (BR.tab !== x.dataset.brTab) { BR.tab = x.dataset.brTab; renderResult(); } return; }
  if ((x = el('[data-br-pside]'))) {
    BR.pside = x.dataset.brPside;
    BR.ptAll = false;
    x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x));
    redrawLists();
    return;
  }
  if ((x = el('th[data-br-psort]'))) {
    const k = x.dataset.brPsort;
    BR.psort = BR.psort.key === k ? { key: k, dir: BR.psort.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'name' || k === 'side' ? 'asc' : 'desc' };
    redrawLists();
    return;
  }
  if (el('[data-br-ptall]')) { BR.ptAll = true; redrawLists(); return; }
  if ((x = el('[data-br-narrow]'))) {
    BR.narrow = x.dataset.brNarrow === '1';
    try { localStorage.setItem(NARROW_KEY, BR.narrow ? '1' : '0'); } catch { /* 忽略 */ }
    $('brResult').classList.toggle('kb-br-narrow', BR.narrow);
    x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x));
    drawTimeline();
    return;
  }
  if ((x = el('[data-br-chart]'))) {
    BR.chart = x.dataset.brChart;
    x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x));
    drawTimeline();
  }
}

// 战局复盘的数据：按时间排序的击杀（标出损失方）与各方舰船组成
function replayModel(sides, stats) {
  const kills = BR.data.kills.filter((k) => !PODS.has(k[3])).map(([id, t, sys, ship, value, vChar, vCorp, vAlliance]) => ({
    id, t, sys, ship, value, char: vChar, party: vAlliance || vCorp, side: BR.side.get(partyOf(vCorp, vAlliance)) || null
  }));
  const t0 = (kills[0]?.t || BR.data.start) - 60;
  const t1 = Math.max((kills[kills.length - 1]?.t || BR.data.end) + 30, t0 + 120);
  return { key: BR.key + '|' + [...BR.side].join(','), kills, t0, t1, sides, fielded: Object.fromEntries(sides.map((s) => [s, stats[s].fielded])) };
}

// 战场模拟：每名飞行员按第一艘出现的舰船计一次（换船不重复计），实际损失按舰船类型对照
function openSim() {
  if (sidesUsed().length > 2) { ctx.app.showToast('战场模拟只支持两方：先把 C / D 方的势力移到 A、B 方或移出', 'info', 4000); return; }
  const side = (s) => {
    const st = sideStats(s);
    const count = new Map();
    for (const c of st.pilots) {
      const ship = [...(BR.pilotShips.get(c) || [])][0];
      if (ship) count.set(ship, (count.get(ship) || 0) + 1);
    }
    // 本场这型船的损失（对战模拟优先按这些击杀取装配）
    const kills = new Map();
    for (const k of st.losses) if (!PODS.has(k[3])) (kills.get(k[3]) || kills.set(k[3], []).get(k[3])).push(k[0]);
    return { rows: [...count].sort((a, b) => b[1] - a[1]).map(([ship, n]) => ({ ship, count: n, kills: (kills.get(ship) || []).slice(0, 60) })), lost: [...st.lostByType], kills };
  };
  const A = side('A'), B = side('B');
  // 本方这型船没阵亡时，可以借用对方同型船的阵亡装配
  for (const [me, other] of [[A, B], [B, A]]) for (const r of me.rows) r.killsOther = (other.kills.get(r.ship) || []).slice(0, 60);
  if (!A.rows.length || !B.rows.length) { ctx.app.showToast('两方都要有舰船才能模拟', 'info'); return; }
  const sys = BR.data.systems.map((id) => ctx.kb.systemLabel(id).name).join('、');
  ctx.app.openBattleSim({ title: `${sys} ${fmtTime(BR.data.start)}`, a: A.rows, b: B.rows, real: { A: A.lost, B: B.lost } });
}

// ---------- 分享图片 ----------
const PERCENT = (v) => (v * 100).toFixed(1) + '%';
const PLAYERS_IMG = 30;   // 分享图片每方最多列出的玩家

function imageModel() {
  const d = BR.data;
  const order = sidesUsed();
  const stats = Object.fromEntries(order.map((s) => [s, sideStats(s)]));
  const A = stats.A, B = stats.B;
  const info = ratioInfo(A, B);
  const lostAll = order.reduce((t, s) => t + stats[s].lost, 0);
  const isk = ctx.app.formatISK, num = ctx.app.formatNumber;
  const pilots = BR.pilotParty.size;
  const total = d.kills.reduce((sum, k) => sum + k[4], 0);
  const names = d.systems.map((id) => ctx.kb.systemLabel(id).name);
  // 参战玩家：每方按参与击杀、损失排序取前 PLAYERS_IMG 名
  const org = new Map(pilotRows().map((r) => [r.char, r]));   // 所属：最后一次出现时的军团 / 联盟
  const logo = (kind, id) => (id ? { name: ctx.partyName(id) || '', logo: ctx.avatar(kind, id, 32) } : null);
  const players = (s) => {
    const list = [...BR.pilotStats.keys()].filter((c) => BR.side.get(BR.pilotParty.get(c)) === s);
    list.sort((a, b) => BR.pilotStats.get(b).kills.size - BR.pilotStats.get(a).kills.size || BR.pilotStats.get(b).lost - BR.pilotStats.get(a).lost);
    return {
      more: Math.max(0, list.length - PLAYERS_IMG),
      list: list.slice(0, PLAYERS_IMG).map((c) => {
        const st = BR.pilotStats.get(c), party = BR.pilotParty.get(c);
        return {
          name: ctx.partyName(c) || String(c), party: party ? ctx.partyName(party) || '' : '', avatar: ctx.avatar('character', c, 64),
          corp: logo('corporation', org.get(c)?.corp), alliance: logo('alliance', org.get(c)?.alliance),
          ships: [...(BR.pilotShips.get(c) || [])].slice(0, 3).map((t) => ctx.IMG(`types/${t}/icon`, 32)),
          kills: st.kills.size, losses: st.losses, lostText: st.lost >= 1e5 ? isk(st.lost) : '', dmgText: st.dmg ? fmtDmg(st.dmg) : ''
        };
      })
    };
  };
  const side = (st, s) => ({
    players: players(s),
    lostText: isk(st.lost), pilots: num(st.pilots.size), partyCount: st.parties.length,
    // 三方及以上的卡片：击毁、ISK 效率、损失占比
    destroyedText: isk(st.destroyed),
    effText: st.destroyed + st.lost ? PERCENT(st.destroyed / (st.destroyed + st.lost)) : '—',
    share: lostAll ? st.lost / lostAll : 1 / order.length, shareText: PERCENT(lostAll ? st.lost / lostAll : 1 / order.length),
    parties: st.parties.slice(0, 6).map((p) => ({
      name: ctx.partyName(p.id), logo: ctx.avatar(p.kind, p.id, 64), pilots: p.pilots.size, kills: p.kills.size, lost: p.lost, lostText: isk(p.lost)
    })),
    more: Math.max(0, st.parties.length - 6),
    top: st.losses.filter((k) => !PODS.has(k[3])).slice(0, 10).map((k) => ({
      ship: ctx.typeName(k[3]), icon: ctx.IMG(`types/${k[3]}/icon`, 64), value: isk(k[4]) + ' ISK',
      pilot: [k[5] ? ctx.partyName(k[5]) : '', k[7] || k[6] ? ctx.partyName(k[7] || k[6]) : ''].filter(Boolean).join(' · ')
    }))
  });
  const cd = chartData();
  const axis = niceAxis(Math.max(...order.map((s) => cd.acc[s])));
  const perPilot = (st) => (st.pilots.size ? st.lost / st.pilots.size : 0);
  const cmp = (label, a, b, f = num) => ({ label, a, b, aText: f(a), bText: f(b) });
  return {
    title: names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 个星系` : names.join('、'),
    meta: [`${fmtTime(d.start)} – ${fmtTime(d.end)} ${tzLabel()}`, `${d.kills.length} 次击杀`, `${num(pilots)} 名飞行员`, `总损失 ${isk(total)} ISK`],
    order, sides: Object.fromEntries(order.map((s) => [s, side(stats[s], s)])),
    ratio: info.ratio, verdict: info.verdict, winner: info.winner,
    shareA: info.pa, shareAText: PERCENT(info.pa), shareBText: PERCENT(1 - info.pa), eff: info.effText,
    cmps: order.length > 2 ? [] : [cmp('舰船损失', A.ships, B.ships), ...(A.pods + B.pods ? [cmp('太空舱', A.pods, B.pods)] : []),
      cmp('参战人数', A.pilots.size, B.pilots.size), cmp('人均损失', perPilot(A), perPilot(B), isk)],
    series: {
      t0: cd.t0, t1: cd.t1, lines: order.map((s) => ({ s, pts: cd.cum[s] })), axis,
      ticks: Array.from({ length: Math.round(axis.max / axis.step) + 1 }, (_, i) => ({ v: i * axis.step, label: axisIsk(i * axis.step) })),
      labels: Array.from({ length: 5 }, (_, i) => fmtClock(cd.t0 + (cd.t1 - cd.t0) * i / 4)),
      // 最贵的几次损失：在曲线上画圈
      marks: order.flatMap((s) => cd.cum[s].slice(1).map((p) => [p[0], p[1], p[2][4], s])).sort((a, b) => b[2] - a[2]).slice(0, 6)
    },
    footer: `击杀数据按吉他${window.__kbPriceSell ? '卖价' : '中间价'}估值`,
    generated: '生成于 ' + fmtTime(Math.floor(Date.now() / 1000)) + ' ' + tzLabel()
  };
}

let imageModule = null;
function shareImage() {
  if (!imageModule) imageModule = Promise.all([import('./kb-br-image.js?v=v32'), import('./share-image.js?v=11')]);
  const model = imageModel();
  const name = `战场统计-${ctx.kb.systemLabel(BR.data.systems[0]).name}-${fmtTime(BR.data.start).replace(/[: ]/g, '')}.png`;
  imageModule.then(([{ renderBrImage }, { openShareModal, shareUrl }]) => openShareModal({
    title: '分享战况图片', fileName: name, app: ctx.app,
    render: (theme) => renderBrImage({ ...model, url: shareUrl(hashFor()) }, theme),
    link: () => location.origin + location.pathname + hashFor()
  })).catch((error) => {
    imageModule = null;
    ctx.app.showToast('生成图片失败：' + error.message, 'error', 4000);
  });
}
