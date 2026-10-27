// 我的建筑市场：当前角色能读取的玩家建筑市场（交易中心比价、倒卖排行、订单簿共用）
// 发现方式：
//   1. 扫描：候选 = 公开市场建筑列表（/universe/structures/?filter=market）+ 角色能停靠的建筑（跳跃规划的建筑发现：建筑搜索、资产、订单、合同、克隆、工业任务）
//      + 本地见过的建筑，只留能装市场模块的铁壁 / 星城，逐座试读 /markets/structures/{id}/：200 可读，403 没有权限，404 没有市场。
//      403 / 404 计入 ESI 错误限额（每分钟 100 次），剩余额度低于 20 时暂停到重置。
//   2. 手动添加：建筑 ID、游戏内链接（showinfo:类型//ID）或名称（有建筑搜索权限时按名称搜）。
// 结果按服务器 + 角色存在本地；勾选的建筑参与比价与排行。令牌只在浏览器里，服务器拿不到这些数据。
import { SERVER, serverKey } from './server.js?v=s4';
import * as JP from './jump-planner.js?v=v16';

export const MARKET_STRUCTURE_TYPES = new Set([35833, 35834, 40340, 47512, 47513, 47514, 47515, 47516]);
export const STRUCT_MARKET_SCOPE = 'esi-markets.structure_markets.v1';
const DEPTH = 0.05;            // 与交易中心比价相同：最优价 5% 以内算可成交深度
const RESCAN_HINT = 7 * 86400e3;
const SKIP_TTL = 3 * 86400e3;   // 扫描时读不了的建筑 3 天内不再试（403 / 404 都消耗错误额度）

let ctx = null;   // getToken, readToken, hasScope, structureMarket, structureNameMap, saveStructureNames, systemRegions, regionName, esc, showToast, formatNumber
const listeners = new Set();
let S = null;     // { cid, list: [{ id, name, system, type, status, pages, at, on, manual }], scanAt }
let scanning = null;
let progress = '';

export function initStructMarkets(context) { ctx = context; }
export function onStructChange(fn) { listeners.add(fn); }
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* 单个监听出错不影响其他 */ } });

function storeKey(cid) { return serverKey('eve-struct-markets') + '-' + cid; }
function state() {
  const token = ctx?.readToken();
  const cid = token?.character_id || 0;
  if (S && S.cid === cid) return S;
  S = { cid, list: [], scanAt: 0, skip: {} };
  if (cid) {
    try { Object.assign(S, JSON.parse(localStorage.getItem(storeKey(cid)) || '{}'), { cid }); } catch { /* 忽略 */ }
  }
  return S;
}
function save() {
  if (!S?.cid) return;
  try { localStorage.setItem(storeKey(S.cid), JSON.stringify({ list: S.list, scanAt: S.scanAt, skip: S.skip })); } catch { /* 忽略 */ }
}

export function hasStructScope() {
  const token = ctx?.readToken();
  return Boolean(token?.access_token && ctx.hasScope(token, STRUCT_MARKET_SCOPE));
}

// 勾选且可读的建筑，带所在星域
export async function enabledStructs() {
  if (!hasStructScope()) return [];
  const list = state().list.filter((s) => s.on && s.status === 'ok');
  if (!list.length) return [];
  const regions = await ctx.systemRegions().catch(() => new Map());
  return list.map((s) => ({ ...s, region: regions.get(s.system) || 0, label: shortName(s.name, s.id) }));
}
// 可读的建筑（含未勾选），倒卖排行的目标市场搜索用
export function readableStructs() { return hasStructScope() ? state().list.filter((s) => s.status === 'ok').map((s) => ({ id: s.id, name: shortName(s.name, s.id), on: Boolean(s.on) })) : []; }
export function enableStruct(id) {
  const item = state().list.find((s) => s.id === id && s.status === 'ok');
  if (item && !item.on) { item.on = true; save(); emit(); }
  return Boolean(item);
}
export function enabledCount() { return hasStructScope() ? state().list.filter((s) => s.on && s.status === 'ok').length : 0; }

// 「Jita - 名字」：表格里放得下的短名
export function shortName(name, id) { return name || '建筑 ' + id; }

// 一座建筑一个物品的行情（与交易中心比价同一口径）
export function structQuote(orders) {
  const sells = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
  const buys = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
  const sell = sells[0]?.price ?? null, buy = buys[0]?.price ?? null;
  return {
    sell, buy,
    sellQty: sells.reduce((s, o) => s + o.volume_remain, 0),
    buyQty: buys.reduce((s, o) => s + o.volume_remain, 0),
    sellDepth: sell == null ? 0 : sells.filter((o) => o.price <= sell * (1 + DEPTH)).reduce((s, o) => s + o.volume_remain, 0),
    buyDepth: buy == null ? 0 : buys.filter((o) => o.price >= buy * (1 - DEPTH) && (o.min_volume || 1) <= 1).reduce((s, o) => s + o.volume_remain, 0)
  };
}

// 读取全部勾选建筑的市场（结果由 structureMarket 缓存 5 分钟）；返回 [{ s, byType }]，读不到的跳过
export async function loadEnabledMarkets(onProgress = () => {}) {
  const list = await enabledStructs();
  const out = [];
  let done = 0;
  const queue = list.slice();
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const r = await ctx.structureMarket(s.id).catch(() => null);
      if (r?.byType) out.push({ s, byType: r.byType });
      else if (r?.denied) markStatus(s.id, 'denied');
      onProgress(++done, list.length);
    }
  }));
  return out.sort((a, b) => list.indexOf(a.s) - list.indexOf(b.s));
}

function markStatus(id, status) {
  const item = state().list.find((s) => s.id === id);
  if (item && item.status !== status) { item.status = status; item.at = Date.now(); save(); emit(); }
}

// ---------- 试读 ----------
let pauseUntil = 0;
async function probe(id) {
  const wait = pauseUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const token = await ctx.getToken();
  const r = await fetch(`${SERVER.esi}/markets/structures/${id}/?datasource=${SERVER.datasource}&page=1`, { headers: { Authorization: 'Bearer ' + token.access_token } }).catch(() => null);
  if (!r) return { status: 'error' };
  const remain = r.headers.get('x-esi-error-limit-remain');
  if (remain !== null && Number(remain) < 20) pauseUntil = Date.now() + (Number(r.headers.get('x-esi-error-limit-reset')) || 60) * 1000;
  if (r.ok) return { status: 'ok', pages: Number(r.headers.get('x-pages')) || 1 };
  if (r.status === 401) return { status: 'auth' };
  if (r.status === 403) {
    const body = await r.json().catch(() => ({}));
    return { status: /scope/i.test(body.error || '') ? 'auth' : 'denied' };
  }
  if (r.status === 404) return { status: 'nomarket' };
  return { status: 'error' };
}

// 建筑名称 / 星系 / 类型（本地缓存 → /universe/structures/{id}/）
async function structInfo(id) {
  const map = ctx.structureNameMap();
  const v = map.get(id);
  if (v?.n) return { name: v.n, system: v.s, type: v.t };
  try {
    const token = await ctx.getToken();
    const r = await fetch(`${SERVER.esi}/universe/structures/${id}/?datasource=${SERVER.datasource}`, { headers: { Authorization: 'Bearer ' + token.access_token } });
    if (!r.ok) return null;
    const info = await r.json();
    map.set(id, { n: info.name, s: info.solar_system_id, t: info.type_id, at: Date.now() });
    ctx.saveStructureNames();
    return { name: info.name, system: info.solar_system_id, type: info.type_id };
  } catch { return null; }
}

async function probeInto(ids, { manual = false, onProgress = () => {} } = {}) {
  const st = state();
  const byId = new Map(st.list.map((s) => [s.id, s]));
  const queue = [...new Set(ids)];
  let done = 0, authFail = 0;
  const total = queue.length;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length && authFail < 3) {
      const id = queue.shift();
      const res = await probe(id);
      if (res.status === 'auth') { authFail += 1; continue; }
      let item = byId.get(id);
      if (!item) {
        if (res.status !== 'ok' && !manual) {   // 扫描时只记下能读的，读不了的记入跳过名单
          if (res.status !== 'error') st.skip[id] = Date.now();
          onProgress(++done, total);
          continue;
        }
        const info = await structInfo(id);
        item = { id, name: info?.name || '', system: info?.system || 0, type: info?.type || 0, on: true, manual };
        byId.set(id, item);
        st.list.push(item);
      }
      if (res.status !== 'error') { item.status = res.status; item.pages = res.pages || 0; item.at = Date.now(); }
      if (manual) item.manual = true;
      onProgress(++done, total);
    }
  }));
  if (authFail >= 3) throw new Error('当前授权读不了建筑市场，请重新绑定 ESI 并勾选「建筑市场」权限');
  st.list.sort((a, b) => (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1) || (b.pages || 0) - (a.pages || 0) || a.name.localeCompare(b.name));
  save();
  emit();
}

export async function scanStructures(onProgress = () => {}) {
  if (scanning) return scanning;
  scanning = (async () => {
    onProgress('查找公开市场建筑与你能停靠的建筑…');
    const candidates = new Set();
    const pub = await fetch(`${SERVER.esi}/universe/structures/?datasource=${SERVER.datasource}&filter=market`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    pub.forEach((id) => candidates.add(id));
    try {
      const found = await JP.loadPublicStructures(ctx.getToken, (d, t, phase) => onProgress(phase === 'private' ? `查找你能停靠的建筑 ${d}/${t}…` : phase === 'detail' ? `读取你能停靠的建筑详情 ${d}/${t}…` : `读取玩家建筑列表 ${d}/${t}…`));
      // 公开可停靠但不在公开市场列表里的建筑，市场一般也不对外，只试私有（军团 / 联盟）建筑
      for (const s of found.private || []) if (MARKET_STRUCTURE_TYPES.has(s.type)) candidates.add(s.id);
    } catch { /* 建筑发现失败时只试公开市场列表 */ }
    for (const [id, v] of ctx.structureNameMap()) if (v?.n && MARKET_STRUCTURE_TYPES.has(v.t)) candidates.add(id);
    const st = state();
    st.skip = st.skip || {};
    for (const [id, at] of Object.entries(st.skip)) if (Date.now() - at > SKIP_TTL) delete st.skip[id];
    const listed = new Set(st.list.map((s) => s.id));
    const ids = [...candidates].filter((id) => listed.has(id) || !st.skip[id]);
    for (const id of listed) if (!ids.includes(id)) ids.push(id);
    await probeInto(ids, { onProgress: (d, t) => onProgress(`逐座试读玩家建筑市场 ${d}/${t}${pauseUntil > Date.now() ? '（ESI 错误额度快用完，暂停中）' : ''}`) });
    state().scanAt = Date.now();
    save();
    return ids.length;
  })().finally(() => { scanning = null; });
  return scanning;
}

// 手动添加：ID / showinfo 链接 / 名称
async function parseManual(text) {
  const ids = new Set();
  for (const m of text.matchAll(/showinfo:\d+\/\/(\d{13,})/g)) ids.add(Number(m[1]));
  for (const m of text.replace(/showinfo:\d+\/\/\d+/g, ' ').matchAll(/\b(1\d{12,})\b/g)) ids.add(Number(m[1]));
  const names = text.replace(/<[^>]+>/g, '\n').replace(/showinfo:\S+/g, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 3 && !/^\d+$/.test(s));
  const misses = [];
  if (names.length) {
    const map = ctx.structureNameMap();
    const token = await ctx.getToken();
    for (const n of names.slice(0, 10)) {
      const lower = n.toLowerCase();
      let hit = [...map].filter(([, v]) => v?.n && v.n.toLowerCase() === lower).map(([id]) => id);
      if (!hit.length && ctx.hasScope(token, JP.STRUCTURE_SEARCH_SCOPE)) {
        const r = await fetch(`${SERVER.esi}/characters/${token.character_id}/search/?categories=structure&search=${encodeURIComponent(n)}&datasource=${SERVER.datasource}`, { headers: { Authorization: 'Bearer ' + token.access_token } }).catch(() => null);
        if (r?.ok) hit = ((await r.json().catch(() => ({}))).structure || []).slice(0, 5);
      }
      if (hit.length) hit.forEach((id) => ids.add(id)); else misses.push(n);
    }
  }
  return { ids: [...ids], misses };
}

// ---------- 管理对话框 ----------
let modal = null;
const STATUS = { ok: ['可读', 'ok'], denied: ['没有权限', 'no'], nomarket: ['没有市场', 'no'], error: ['读取失败', 'no'] };

export function openStructManager() {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'smTitle');
    modal.innerHTML = `<div class="modal-backdrop" data-sm-close></div>
      <div class="modal-content sm-modal">
        <div class="modal-header"><h3 id="smTitle">玩家建筑市场</h3>
          <button class="modal-close" data-sm-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body" id="smBody"></div>
      </div>`;
    document.body.appendChild(modal);
    bindDialog();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
    onStructChange(() => { if (!modal.hidden) renderDialog(); });
  }
  modal.hidden = false;
  renderDialog();
}

function renderDialog() {
  const { esc, formatNumber } = ctx;
  const body = modal.querySelector('#smBody');
  const token = ctx.readToken();
  if (!token?.access_token) { body.innerHTML = '<p class="pi-note">绑定 ESI 后才能读取玩家建筑里的市场。</p>'; return; }
  if (!hasStructScope()) {
    body.innerHTML = `<p class="pi-note">当前授权没有「建筑市场」权限（${STRUCT_MARKET_SCOPE}），请在个人中心重新绑定 ESI。</p>`;
    return;
  }
  const st = state();
  const on = st.list.filter((s) => s.on && s.status === 'ok').length;
  const pages = st.list.filter((s) => s.on && s.status === 'ok').reduce((n, s) => n + (s.pages || 1), 0);
  const rows = st.list.map((s) => {
    const [label, cls] = STATUS[s.status] || ['未试读', 'no'];
    return `<li class="sm-row${s.status === 'ok' ? '' : ' off'}">
      <label><input type="checkbox" data-sm-on="${s.id}" ${s.on && s.status === 'ok' ? 'checked' : ''} ${s.status === 'ok' ? '' : 'disabled'}>
        <span class="sm-name">${esc(shortName(s.name, s.id))}<small>${s.id}${s.manual ? ' · 手动添加' : ''}</small></span></label>
      <span class="sm-badge ${cls}">${label}${s.status === 'ok' && s.pages ? ` · ${formatNumber(s.pages)} 页订单` : ''}</span>
      <button class="icon-btn small" data-sm-del="${s.id}" title="移除" aria-label="移除">✕</button></li>`;
  }).join('');
  const stale = st.scanAt && Date.now() - st.scanAt > RESCAN_HINT;
  body.innerHTML = `
    <p class="pi-note">勾选的建筑会和五大交易中心一起出现在「交易中心比价」「倒卖排行」里，订单簿（含全宇宙）也会并入它们的订单。数据由你的浏览器用你的授权直接读 ESI，本站服务器拿不到。</p>
    <div class="sm-actions">
      <button class="btn btn-primary" data-sm-scan ${scanning ? 'disabled' : ''}>${scanning ? '扫描中…' : st.scanAt ? '重新扫描' : '扫描我能读的建筑'}</button>
      <span class="sm-progress">${esc(progress || (st.scanAt ? `上次扫描 ${new Date(st.scanAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${stale ? '，建议重新扫描' : ''}` : '会试读公开市场建筑和你能停靠的铁壁 / 星城，首次可能要几分钟'))}</span>
    </div>
    <div class="sm-add">
      <textarea class="pi-input" data-sm-input rows="2" placeholder="手动添加：建筑 ID、游戏里拖到聊天框的建筑链接，或建筑全名（一行一个）"></textarea>
      <button class="btn" data-sm-add>添加</button>
    </div>
    ${st.list.length ? `<p class="sm-sum">已启用 ${on} 座${on ? `，每次读取约 ${formatNumber(pages)} 页订单` : ''}${on > 10 ? '，建筑太多会让比价和排行变慢' : ''}</p><ul class="sm-list">${rows}</ul>` : '<p class="sm-sum">还没有建筑，先扫描或手动添加。</p>'}`;
}

function bindDialog() {
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('[data-sm-close]')) { modal.hidden = true; return; }
    if (e.target.closest('[data-sm-scan]')) {
      const run = scanStructures((t) => { progress = t; const p = modal.querySelector('.sm-progress'); if (p) p.textContent = t; });
      renderDialog();
      try {
        await run;
        const ok = state().list.filter((s) => s.status === 'ok').length;
        progress = `扫描完成：${ok} 座建筑可读`;
      } catch (err) { progress = '扫描失败：' + err.message; }
      renderDialog();
      return;
    }
    if (e.target.closest('[data-sm-add]')) {
      const input = modal.querySelector('[data-sm-input]');
      const text = input.value.trim();
      if (!text) return;
      progress = '正在识别并试读…';
      renderDialog();
      try {
        const { ids, misses } = await parseManual(text);
        if (ids.length) await probeInto(ids, { manual: true });
        progress = (ids.length ? `添加了 ${ids.length} 座` : '没有识别到建筑') + (misses.length ? `；找不到：${misses.slice(0, 3).join('、')}${misses.length > 3 ? ' 等' : ''}（名称要完整，或改填建筑 ID）` : '');
      } catch (err) { progress = '添加失败：' + err.message; }
      renderDialog();
      return;
    }
    const del = e.target.closest('[data-sm-del]');
    if (del) {
      const st = state();
      st.list = st.list.filter((s) => s.id !== Number(del.dataset.smDel));
      save(); emit();
    }
  });
  modal.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sm-on]');
    if (!cb) return;
    const item = state().list.find((s) => s.id === Number(cb.dataset.smOn));
    if (item) { item.on = cb.checked; save(); emit(); }
  });
}
