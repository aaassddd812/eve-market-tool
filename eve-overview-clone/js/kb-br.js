// ===== 战场统计（Battle Report）=====
// 选择星系（可勾选星门邻近星系）与时间段，向击杀记录服务读取期间全部玩家击杀与攻击者，
// 按联盟（无联盟时按军团）汇总，自动推测 A / B 双方阵营（可手动调整），统计双方人数、损失、舰船组成与损失明细。
// 路由：#kb/br（设置）、#kb/br/<星系,…>/<开始>-<结束>[/<A 方,…>/<B 方,…>]（时间为 Unix 秒，可分享）
import { initReplay, mountReplay, stopReplay, resizeReplay } from './kb-br-replay.js?v=v4';
import { getTz, setTz, tzLabel, isoIn, parseIn } from './eve-time.js?v=v1';
let ctx;                       // kb-page 提供的工具：app, kb, request, absorbNames, partyName, typeName, loadTypes, avatar, entityLink, IMG
const $ = (id) => document.getElementById(id);
const PODS = new Set([670, 33328]);
const MAX_SYSTEMS = 30;
const MAX_HOURS = 72;
const QUICK = [1, 3, 6, 12, 24, 72];

const BR = {
  picked: [],                // 搜索添加的星系（总是选中）
  checked: new Set(),        // 勾选的邻近星系
  jumps: 1,
  start: 0, end: 0,          // Unix 秒
  data: null, key: '',       // 当前结果与对应的查询
  parties: new Map(),        // 势力 id -> { id, kind, pilots:Set, kills:Set, losses, lost }
  side: new Map(),           // 势力 id -> 'A' | 'B'（未分配不记录）
  view: 'A'                  // 窄屏下显示哪一方的明细
};

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
  const m = /^#kb\/br(?:\/([\d,]+)\/(\d+)-(\d+)(?:\/([\d,]*|-)\/([\d,]*|-))?)?/.exec(hash);
  if (!m) return null;
  const ids = (v) => (v && v !== '-' ? v.split(',').map(Number).filter(Boolean) : []);
  return m[1] ? { systems: ids(m[1]), start: Number(m[2]), end: Number(m[3]), a: ids(m[4]), b: ids(m[5]) } : {};
}

function hashFor(withSides = true) {
  const systems = selectedSystems();
  let h = `#kb/br/${systems.join(',')}/${BR.start}-${BR.end}`;
  if (withSides && BR.side.size) {
    const list = (s) => [...BR.side].filter(([, v]) => v === s).map(([id]) => id).join(',') || '-';
    h += `/${list('A')}/${list('B')}`;
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
        <span class="text-muted">选择星系与时间段，按联盟划分双方阵营，统计人数、损失与舰船组成</span>
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
      <span class="text-muted">最多 ${MAX_SYSTEMS} 个星系、${MAX_HOURS} 小时；本站保留最近 30 天的击杀</span>
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
  loadResult({ systems, start: BR.start, end: BR.end, a: [], b: [] });
}

// ---------- 读取与汇总 ----------
async function loadResult(p) {
  const box = $('brResult');
  box.innerHTML = `<div class="kb-br-loading"><span class="spinner"></span>正在读取击杀记录…</div>`;
  const key = `${p.systems.join(',')}|${p.start}|${p.end}`;
  try {
    const data = BR.key === key && BR.data ? BR.data : await ctx.request(`br?systems=${p.systems.join(',')}&start=${p.start}&end=${p.end}`);
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
    p.a.forEach((id) => BR.side.set(id, 'A'));
    p.b.forEach((id) => BR.side.set(id, 'B'));
  } else {
    autoSides();
    history.replaceState(null, '', hashFor());
  }
  renderResult();
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
    if (vChar) vp.pilots.add(vChar);
    addShip(vChar, ship, vp.id);
    const atkParties = new Set();
    for (const [char, corp, alliance, aship] of att) {
      const ap = party(corp, alliance);
      ap.pilots.add(char);
      ap.kills.add(id);
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
}

function sideStats(s) {
  const other = s === 'A' ? 'B' : 'A';
  const st = { pilots: new Set(), parties: [], ships: 0, pods: 0, lost: 0, destroyed: 0, losses: [], fielded: new Map(), lostByType: new Map() };
  for (const p of BR.parties.values()) if (BR.side.get(p.id) === s) { st.parties.push(p); p.pilots.forEach((c) => st.pilots.add(c)); }
  for (const k of BR.data.kills) {
    const vs = BR.side.get(partyOf(k[6], k[7]));
    if (vs === s) {
      st.lost += k[4];
      if (PODS.has(k[3])) st.pods += 1; else { st.ships += 1; st.lostByType.set(k[3], (st.lostByType.get(k[3]) || 0) + 1); }
      st.losses.push(k);
    } else if (vs === other) {
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
    const old = d.start < Date.now() / 1000 - d.retention_days * 86400;
    box.innerHTML = `<p class="kb-empty text-muted">这段时间内所选星系没有玩家击杀${old ? `（本站只保留最近 ${d.retention_days} 天的击杀）` : ''}</p>`;
    return;
  }
  const A = sideStats('A'), B = sideStats('B');
  const total = d.kills.reduce((s, k) => s + k[4], 0);
  const pilots = new Set([...BR.pilotParty.keys()]).size;
  const unassigned = [...BR.parties.values()].filter((p) => !BR.side.get(p.id)).sort((a, b) => b.pilots.size - a.pilots.size || b.lost - a.lost);
  const sysList = d.systems.map((id) => ctx.kb.systemLabel(id).name).join('、');
  box.innerHTML = `
    <div class="kb-br-summary">
      <div class="kb-br-title">
        <strong>${ctx.app.esc(sysList)}</strong>
        <span class="text-muted">${fmtTime(d.start)} – ${fmtTime(d.end)} ${tzLabel()} · ${d.kills.length} 次击杀 · ${ctx.app.formatNumber(pilots)} 名飞行员 · 总损失 ${ctx.app.formatISK(total)} ISK${d.truncated ? ' · 击杀过多，只统计前 5000 条' : ''}</span>
      </div>
      <div class="kb-br-tools">
        <button class="btn btn-ghost" data-br-auto title="按击杀关系重新推测双方">重新分阵营</button>
        <button class="btn btn-ghost${BR.replay ? ' active' : ''}" data-br-replay title="按击杀邮件的时间点回放这场会战">战局复盘</button>
        <button class="btn btn-ghost" data-br-share>复制链接</button>
        ${ctx.app.openBattleSim ? '<button class="btn btn-ghost" data-br-sim title="按双方实际出场的舰船（装配取击杀记录里最常见的一套）进行战场模拟">战场模拟</button>' : ''}
        <button class="btn btn-primary" data-br-image title="生成战况图片，可下载或复制后分享">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg><span>分享图片</span>
        </button>
      </div>
    </div>
    ${BR.replay ? '<div id="brReplay"></div>' : ''}
    ${ratioHero(A, B)}
    ${timelineBox()}
    <div class="segmented kb-br-switch" role="group" aria-label="查看哪一方">
      <button data-br-view="A" class="${BR.view === 'A' ? 'active' : ''}">A 方</button><button data-br-view="B" class="${BR.view === 'B' ? 'active' : ''}">B 方</button>
    </div>
    <div class="kb-br-cols" data-view="${BR.view}">
      ${sideColumn('A', A)}
      ${sideColumn('B', B)}
    </div>
    ${unassigned.length ? `<section class="kb-br-col kb-br-third">
      <h4>未分配 / 第三方<span>${unassigned.length} 个势力 · 点 A / B 加入一方</span></h4>
      <div class="kb-br-parties">${unassigned.map((p) => partyRow(p, null)).join('')}</div>
    </section>` : ''}`;
  box.onclick = onResultClick;
  if (BR.replay) mountReplay($('brReplay'), replayModel(A, B)); else stopReplay();
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

function partyRow(p, side) {
  const move = side === 'A' ? ['B'] : side === 'B' ? ['A'] : ['A', 'B'];
  return `<div class="kb-br-party">
    <img src="${ctx.avatar(p.kind, p.id, 32)}" alt="" width="28" height="28" loading="lazy">
    <div class="kb-br-party-main">${ctx.entityLink(p.kind, p.id)}<small>${p.pilots.size} 人 · 参与击杀 ${p.kills.size} · 损失 ${p.losses}（${ctx.app.formatISK(p.lost)}）</small></div>
    <div class="kb-br-move">${move.map((m) => `<button class="m-${m.toLowerCase()}" data-br-move="${p.id}:${m}" title="移到 ${m} 方">${m}</button>`).join('')}${side ? `<button data-br-move="${p.id}:-" title="移出（不计入双方）">×</button>` : ''}</div>
  </div>`;
}

// 每列固定 6 块（标题、势力、舰船组成标题、舰船组成、损失标题、损失），宽屏下两列用 subgrid 逐块对齐；势力列表默认显示 6 个，多的下滑查看
function sideColumn(s, st) {
  const fielded = [...st.fielded].sort((a, b) => b[1] - a[1]);
  const shipRows = fielded.map(([t, n]) => {
    const lost = st.lostByType.get(t) || 0;
    return `<tr><td class="kb-br-ship"><img src="${ctx.IMG(`types/${t}/icon`, 32)}" alt="" width="22" height="22" loading="lazy">${ctx.app.esc(ctx.typeName(t))}</td><td class="num">${n}</td><td class="num${lost ? ' lost' : ''}">${lost || ''}</td></tr>`;
  }).join('');
  const losses = st.losses.slice(0, 200).map((k) => {
    const [id, t, sys, ship, value, vChar, vCorp, vAlliance] = k;
    return `<tr class="kb-row" data-kill="${id}" tabindex="0">
      <td class="kb-br-ship"><img src="${ctx.IMG(`types/${ship}/icon`, 32)}" alt="" width="22" height="22" loading="lazy"><span>${ctx.app.esc(ctx.typeName(ship))}<small>${vChar ? ctx.app.esc(ctx.partyName(vChar)) : ''}${vAlliance || vCorp ? ' · ' + ctx.app.esc(ctx.partyName(vAlliance || vCorp)) : ''}</small></span></td>
      <td class="num">${ctx.app.formatISK(value)}<small>${fmtClock(t)} · ${ctx.app.esc(ctx.kb.systemLabel(sys).name)}</small></td>
    </tr>`;
  }).join('');
  return `<section class="kb-br-col side-${s.toLowerCase()}">
    <h4 class="kb-br-col-title"><i class="kb-br-badge">${s}</i>${s} 方 · 势力<span>${st.parties.length}</span></h4>
    <div class="kb-br-parties">${st.parties.map((p) => partyRow(p, s)).join('') || '<p class="text-muted kb-br-none">从下方「未分配」或另一方移入势力</p>'}</div>
    <h4>舰船组成<span>出场 / 损失</span></h4>
    ${shipRows ? `<div class="table-scroll kb-br-table"><table class="pc-mini-table"><tbody>${shipRows}</tbody></table></div>` : '<p class="text-muted kb-br-none">无</p>'}
    <h4>损失<span>${st.ships + st.pods} · ${ctx.app.formatISK(st.lost)} ISK</span></h4>
    <div>${losses ? `<div class="table-scroll kb-br-table"><table class="pc-mini-table kb-br-losses"><tbody>${losses}</tbody></table></div>${st.losses.length > 200 ? `<p class="text-muted kb-br-none">只显示价值最高的 200 条</p>` : ''}` : '<p class="text-muted kb-br-none">没有损失</p>'}</div>
  </section>`;
}

// ---------- 战况走势图 ----------
// 两种视图：累计损失（阶梯线 + 面积 + 最贵损失标记）与损失分布（按时间分段，A 方向上、B 方向下）
const NICE_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720];
const niceStep = (span, n) => NICE_MIN.find((m) => span / (m * 60) <= n) * 60 || 1440 * 60;

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
  const cum = { A: [[t0, 0]], B: [[t0, 0]] };
  const acc = { A: 0, B: 0 }, cnt = { A: 0, B: 0 };
  for (const k of kills) {
    const s = BR.side.get(partyOf(k[6], k[7]));
    acc[s] += k[4];
    cnt[s] += 1;
    cum[s].push([k[1], acc[s], k]);
  }
  return { kills, t0, t1, cum, acc, cnt };
}

function drawTimeline() {
  const plot = $('brPlot');
  if (!plot || !BR.data?.kills.length) return;
  const cd = chartData();
  const { t0, t1, cum, acc } = cd;
  $('brLegend').innerHTML = `<span class="a"><i></i>A 方损失 <b>${ctx.app.formatISK(acc.A)}</b></span><span class="b"><i></i>B 方损失 <b>${ctx.app.formatISK(acc.B)}</b></span>`;
  const W = Math.max(280, plot.clientWidth), H = W < 600 ? 190 : 230;
  const L = 54, R = 14, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const x = (t) => L + (t - t0) / (t1 - t0) * iw;
  const esc = ctx.app.esc, isk = ctx.app.formatISK;
  let body = '';
  // 时间刻度
  const step = niceStep(t1 - t0, Math.max(3, Math.floor(iw / 90)));
  let xt = '';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    xt += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + ih}"/><text class="ax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmtClock(t)}</text>`;
  }
  const mode = BR.chart === 'bar' ? 'bar' : 'cum';
  let hover;
  if (mode === 'cum') {
    const max = Math.max(acc.A, acc.B, 1) * 1.08;
    const y = (v) => T + ih - v / max * ih;
    let yt = '';
    for (let i = 0; i <= 4; i++) {
      const v = max / 4 * i;
      yt += `<line class="grid${i ? '' : ' base'}" x1="${L}" x2="${L + iw}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${i ? isk(v) : '0'}</text>`;
    }
    const line = (pts) => pts.map(([t, v], i) => (i ? `H${x(t).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(t).toFixed(1)},${y(v).toFixed(1)}`)).join('') + `H${x(t1).toFixed(1)}`;
    const area = (pts) => line(pts) + `V${y(0)}H${x(t0)}Z`;
    body = `<defs>
        <linearGradient id="brGa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--br-a)" stop-opacity=".28"/><stop offset="1" stop-color="var(--br-a)" stop-opacity="0"/></linearGradient>
        <linearGradient id="brGb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--br-b)" stop-opacity=".28"/><stop offset="1" stop-color="var(--br-b)" stop-opacity="0"/></linearGradient>
      </defs>${yt}${xt}
      <path d="${area(cum.A)}" fill="url(#brGa)"/><path d="${area(cum.B)}" fill="url(#brGb)"/>
      <path class="ln a" d="${line(cum.A)}"/><path class="ln b" d="${line(cum.B)}"/>`;
    // 最贵的几次损失标记在曲线上
    const big = [...cum.A.slice(1).map((p) => [...p, 'a']), ...cum.B.slice(1).map((p) => [...p, 'b'])].sort((p, q) => q[2][4] - p[2][4]).slice(0, 6);
    body += big.map(([t, v, k, c]) => `<circle class="mk ${c}" cx="${x(t)}" cy="${y(v)}" r="5" data-kill="${k[0]}"><title>${esc(ctx.typeName(k[3]))} · ${isk(k[4])} ISK · ${fmtClock(t)}</title></circle>`).join('');
    const at = (pts, t) => { let v = 0; for (const p of pts) { if (p[0] > t) break; v = p[1]; } return v; };
    hover = (t) => ({ x: x(t), html: `<b>${fmtClock(t)}</b><span class="a">A 方累计 ${isk(at(cum.A, t))}</span><span class="b">B 方累计 ${isk(at(cum.B, t))}</span>` });
  } else {
    const size = niceStep(t1 - t0, 48);
    const b0 = Math.floor(t0 / size) * size;
    const n = Math.floor((t1 - b0) / size) + 1;
    const bins = Array.from({ length: n }, (_, i) => ({ t: b0 + i * size, A: 0, B: 0, nA: 0, nB: 0 }));
    for (const k of cd.kills) {
      const s = BR.side.get(partyOf(k[6], k[7]));
      const bin = bins[Math.floor((k[1] - b0) / size)];
      bin[s] += k[4];
      bin['n' + s] += 1;
    }
    const max = Math.max(...bins.map((b) => Math.max(b.A, b.B)), 1) * 1.1;
    const mid = T + ih / 2;
    const yh = (v) => v / max * (ih / 2);
    const xb = (t) => L + (t - b0) / (n * size) * iw;
    const bw = Math.max(1, iw / n - (iw / n > 6 ? 2 : 0.5));
    let yt = `<line class="grid base" x1="${L}" x2="${L + iw}" y1="${mid}" y2="${mid}"/>`;
    for (const f of [0.45, 0.9]) {
      const v = max * f;
      yt += `<line class="grid" x1="${L}" x2="${L + iw}" y1="${mid - yh(v)}" y2="${mid - yh(v)}"/><line class="grid" x1="${L}" x2="${L + iw}" y1="${mid + yh(v)}" y2="${mid + yh(v)}"/>`;
      yt += `<text class="ax" x="${L - 8}" y="${mid - yh(v) + 4}" text-anchor="end">${isk(v)}</text><text class="ax" x="${L - 8}" y="${mid + yh(v) + 4}" text-anchor="end">${isk(v)}</text>`;
    }
    xt = '';
    const xs = niceStep(n * size, Math.max(3, Math.floor(iw / 90)));
    for (let t = Math.ceil(b0 / xs) * xs; t <= b0 + n * size; t += xs) xt += `<text class="ax" x="${xb(t)}" y="${H - 8}" text-anchor="middle">${fmtClock(t)}</text>`;
    body = `${yt}${xt}` + bins.map((b) => `${b.A ? `<rect class="bar a" x="${xb(b.t) + 1}" y="${mid - yh(b.A)}" width="${bw}" height="${yh(b.A)}" rx="1.5"/>` : ''}${b.B ? `<rect class="bar b" x="${xb(b.t) + 1}" y="${mid}" width="${bw}" height="${yh(b.B)}" rx="1.5"/>` : ''}`).join('') +
      `<text class="ax side a" x="${L + 6}" y="${T + 10}">A 方损失 ↑</text><text class="ax side b" x="${L + 6}" y="${T + ih - 4}">B 方损失 ↓</text>`;
    hover = (t) => {
      const b = bins[Math.min(n - 1, Math.max(0, Math.floor((t - b0) / size)))];
      return { x: xb(b.t) + 1 + bw / 2, html: `<b>${fmtClock(b.t)} – ${fmtClock(b.t + size)}</b><span class="a">A 方损失 ${isk(b.A)}（${b.nA} 艘）</span><span class="b">B 方损失 ${isk(b.B)}（${b.nB} 艘）</span>` };
    };
  }
  const svg = plot.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  // 悬停层放在最底下（其余元素不接收鼠标事件），损失标记在最上层可点击打开详情
  svg.innerHTML = `<rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/>` + body + `<line class="cross" id="brCross" x1="0" x2="0" y1="${T}" y2="${T + ih}" visibility="hidden"/>`;
  const tip = $('brTip'), cross = svg.querySelector('#brCross');
  const hit = svg.querySelector('.hit');
  hit.onmousemove = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = t0 + (px - L) / iw * (t1 - t0);
    const h = hover(Math.min(t1, Math.max(t0, t)));
    cross.setAttribute('x1', h.x); cross.setAttribute('x2', h.x); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = h.html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(W - tw - 4, Math.max(4, h.x + 12 + tw > W ? h.x - tw - 12 : h.x + 12)) + 'px';
    tip.style.top = T + 4 + 'px';
  };
  hit.onmouseleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
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
    history.replaceState(null, '', hashFor());
    renderResult();
    return;
  }
  if (el('[data-br-auto]')) { autoSides(); history.replaceState(null, '', hashFor()); renderResult(); return; }
  if ((x = el('[data-br-image]'))) { shareImage(x); return; }
  if (el('[data-br-sim]')) { openSim(); return; }
  if (el('[data-br-replay]') || el('[data-br-replay-close]')) {
    BR.replay = !BR.replay;
    renderResult();
    if (BR.replay) $('brReplay')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (el('[data-br-share]')) { ctx.app.copyText(location.origin + location.pathname + hashFor(), '战场统计链接已复制'); return; }
  if ((x = el('[data-br-view]'))) { BR.view = x.dataset.brView; renderResult(); return; }
  if ((x = el('[data-br-chart]'))) {
    BR.chart = x.dataset.brChart;
    x.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === x));
    drawTimeline();
  }
}

// 战局复盘的数据：按时间排序的击杀（标出损失方）与双方舰船组成
function replayModel(A, B) {
  const kills = BR.data.kills.filter((k) => !PODS.has(k[3])).map(([id, t, sys, ship, value, vChar, vCorp, vAlliance]) => ({
    id, t, sys, ship, value, char: vChar, party: vAlliance || vCorp, side: BR.side.get(partyOf(vCorp, vAlliance)) || null
  }));
  const t0 = (kills[0]?.t || BR.data.start) - 60;
  const t1 = Math.max((kills[kills.length - 1]?.t || BR.data.end) + 30, t0 + 120);
  return { key: BR.key + '|' + [...BR.side].join(','), kills, t0, t1, fielded: { A: A.fielded, B: B.fielded } };
}

// 战场模拟：每名飞行员按第一艘出现的舰船计一次（换船不重复计），实际损失按舰船类型对照
function openSim() {
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

function imageModel() {
  const d = BR.data;
  const A = sideStats('A'), B = sideStats('B');
  const info = ratioInfo(A, B);
  const isk = ctx.app.formatISK, num = ctx.app.formatNumber;
  const pilots = BR.pilotParty.size;
  const total = d.kills.reduce((sum, k) => sum + k[4], 0);
  const names = d.systems.map((id) => ctx.kb.systemLabel(id).name);
  const side = (st) => ({
    lostText: isk(st.lost), pilots: num(st.pilots.size), partyCount: st.parties.length,
    parties: st.parties.slice(0, 6).map((p) => ({
      name: ctx.partyName(p.id), logo: ctx.avatar(p.kind, p.id, 64), pilots: p.pilots.size, kills: p.kills.size, lost: p.lost, lostText: isk(p.lost)
    })),
    more: Math.max(0, st.parties.length - 6),
    top: st.losses.filter((k) => !PODS.has(k[3])).slice(0, 3).map((k) => ({
      ship: ctx.typeName(k[3]), icon: ctx.IMG(`types/${k[3]}/icon`, 64), value: isk(k[4]) + ' ISK',
      pilot: [k[5] ? ctx.partyName(k[5]) : '', k[7] || k[6] ? ctx.partyName(k[7] || k[6]) : ''].filter(Boolean).join(' · ')
    }))
  });
  const cd = chartData();
  const perPilot = (st) => (st.pilots.size ? st.lost / st.pilots.size : 0);
  const cmp = (label, a, b, f = num) => ({ label, a, b, aText: f(a), bText: f(b) });
  return {
    title: names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 个星系` : names.join('、'),
    subtitle: `${fmtTime(d.start)} – ${fmtTime(d.end)} ${tzLabel()}  ·  ${d.kills.length} 次击杀  ·  ${num(pilots)} 名飞行员  ·  总损失 ${isk(total)} ISK`,
    sides: { A: side(A), B: side(B) },
    ratio: info.ratio, verdict: info.verdict, winner: info.winner,
    shareA: info.pa, shareAText: PERCENT(info.pa), shareBText: PERCENT(1 - info.pa), eff: info.effText,
    cmps: [cmp('舰船损失', A.ships, B.ships), ...(A.pods + B.pods ? [cmp('太空舱', A.pods, B.pods)] : []),
      cmp('参战人数', A.pilots.size, B.pilots.size), cmp('人均损失', perPilot(A), perPilot(B), isk)],
    series: {
      t0: cd.t0, t1: cd.t1, A: cd.cum.A, B: cd.cum.B, max: Math.max(cd.acc.A, cd.acc.B, 1),
      labels: [fmtClock(cd.t0), fmtClock(cd.t0 + (cd.t1 - cd.t0) / 2), fmtClock(cd.t1)]
    },
    footer: location.host + ' · 击杀数据按吉他中间价估值',
    generated: '生成于 ' + fmtTime(Math.floor(Date.now() / 1000)) + ' ' + tzLabel()
  };
}

let imageModule = null;
async function shareImage(btn) {
  btn.disabled = true;
  const label = btn.querySelector('span');
  const old = label.textContent;
  label.textContent = '生成中…';
  try {
    if (!imageModule) imageModule = import('./kb-br-image.js?v=v18r7');
    const { renderBrImage } = await imageModule;
    const canvas = await renderBrImage(imageModel());
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('浏览器无法导出图片');
    openImageModal(blob);
  } catch (error) {
    imageModule = null;
    ctx.app.showToast('生成图片失败：' + error.message, 'error', 4000);
  } finally {
    btn.disabled = false;
    label.textContent = old;
  }
}

function openImageModal(blob) {
  const url = URL.createObjectURL(blob);
  const name = `战场统计-${ctx.kb.systemLabel(BR.data.systems[0]).name}-${fmtTime(BR.data.start).replace(/[: ]/g, '')}.png`;
  const canCopy = !!(navigator.clipboard && window.ClipboardItem);
  const modal = document.createElement('div');
  modal.className = 'modal kb-br-image-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>分享战况图片</h3>
        <button class="modal-close" data-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="kb-br-image-preview"><img src="${url}" alt="战场统计图片"></div>
        <div class="kb-br-image-actions">
          <span class="text-muted">手机上可长按图片保存</span>
          <button class="btn btn-ghost" data-link>复制链接</button>
          ${canCopy ? '<button class="btn btn-ghost" data-copy>复制图片</button>' : ''}
          <a class="btn btn-primary" href="${url}" download="${ctx.app.esc(name)}">下载图片</a>
        </div>
      </div>
    </div>`;
  const close = () => { modal.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('.modal-backdrop, [data-close]')) { close(); return; }
    if (e.target.closest('[data-link]')) { ctx.app.copyText(location.origin + location.pathname + hashFor(), '战场统计链接已复制'); return; }
    if (e.target.closest('[data-copy]')) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        ctx.app.showToast('图片已复制，可直接粘贴到 QQ / 微信 / Discord', 'success');
      } catch {
        ctx.app.showToast('浏览器不允许复制图片，请使用下载', 'error');
      }
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(modal);
}
