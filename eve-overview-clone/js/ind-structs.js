// ===== 制造：我的建筑 =====
// 在自己（或军团、朋友）的工程复合体、精炼厂、星城里造东西：
//   加成 = 船体自带（ind-rigs.json 的 hulls）× 各改装件（rigs，按产品分类精确匹配过滤器，数值乘建筑所在星系的安全等级倍数）
//   安装费用建筑所在星系的工业指数，税率每座建筑单独填（制造 / 反应 / 科研：发明、拷贝、研究）
// 添加方式：
//   1. 手动：类型、星系、改装件、税率
//   2. 绑定 ESI：按建筑 ID / 游戏内链接 / 名称读取（/universe/structures/{id}/，要能停靠）；
//      扫描：军团建筑（/corporations/{id}/structures/，需军团职位）、你制造任务用过的建筑、跳跃规划发现的你能停靠的建筑
//   3. 军团建筑在有军团资产权限（董事）时，从军团资产里读改装件：位置 = 建筑、栏位 RigSlot0–2
// 按服务器存在本地，令牌只在浏览器里。
// 估价页化矿设置、个人中心「建筑装配」也用这里：建筑列表（useStore 后不依赖制造页）、化矿基础化矿率 reprocBase、
//   军团建筑装配 corpFittings（军团资产里装在建筑上的物品，按军团缓存 5 分钟）、改装件加成说明 rigEffects。
import { serverKey } from './server.js?v=s4';
import * as JP from './jump-planner.js?v=v17';

let X = null;   // industry.js 传入：ctx, D, sysLabel, onChange(列表或数值变化后重算)
let STORE = null;   // 本地存储（制造页 initStructs 或其它页面 useStore 传入）
const RD = { data: null, loading: null };
let list = null;   // [{ key, id, name, type, system, rigs: [typeId], tax: { m, r, i }, src: 'manual'|'esi'|'corp', rigSrc }]
const KEY = () => serverKey('eve-ind-structs');
// 各类建筑能做的活动：精炼厂才能反应；三类都能装制造 / 科研服务
const CAN = { 1404: ['m', 'i', 'c', 'me', 'te'], 1406: ['m', 'i', 'c', 'me', 'te', 'r'], 1657: ['m', 'i', 'c', 'me', 'te'] };
const ASSET_SCOPE = 'esi-assets.read_corporation_assets.v1';
const CORP_STRUCT_SCOPE = 'esi-corporations.read_structures.v1';
// 页面翻译不处理 textarea，占位文字自己翻
const tr = (s) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(s) : s);

export function initStructs(x) { X = x; STORE = x.ctx.store; }
export function useStore(store) { if (!STORE) STORE = store; }
export function loadRigs() {
  if (!RD.loading) {
    RD.loading = fetch('ind-rigs.json?v=2').then((r) => (r.ok ? r.json() : Promise.reject(new Error('ind-rigs.json ' + r.status))))
      .then((d) => { RD.data = d; }).catch((e) => { RD.loading = null; throw e; });
  }
  return RD.loading;
}
const ready = () => Boolean(RD.data);
const hull = (s) => RD.data?.hulls[s.type];

function all() {
  if (!list) list = (STORE.getJSON(KEY(), []) || []).filter((s) => s && s.key);
  return list;
}
function save() { STORE.setJSON(KEY(), list); }
export const structs = () => (ready() ? all().filter((s) => hull(s)) : []);
export const get = (key) => structs().find((s) => s.key === key) || null;
export const canDo = (s, act) => (CAN[hull(s)?.g] || []).includes(act);
export const shortName = (s) => s.name || hull(s)?.n || '建筑';

// 产品属于过滤器吗（0 = 不限）
function inFilter(f, gid, cid) {
  if (!f) return true;
  const x = RD.data.filters[f];
  return Boolean(x && (x.g.includes(gid) || x.c.includes(cid)));
}
export const secCol = (sec) => (sec >= 0.45 ? 0 : sec > 0 ? 1 : 2);

// 建筑 s 做活动 act（m 制造 / r 反应 / i 发明 / c 拷贝 / me / te 研究）时对某产品的总减免 %
// gid / cid：产品的分组与大类；不传时只算船体（以及不限产品的改装件）
export function bonus(s, act, gid = 0, cid = 0) {
  const h = hull(s);
  const mul = { me: 1, te: 1, cost: 1 };
  const hb = h?.b[act];
  if (hb) { mul.me *= 1 - hb[0] / 100; mul.te *= 1 - hb[1] / 100; mul.cost *= 1 - hb[2] / 100; }
  const sec = X.D.sys.get(s.system)?.sec ?? 0.5;
  for (const rid of s.rigs || []) {
    const rig = RD.data.rigs[rid];
    if (!rig) continue;
    const best = {};   // 同一个改装件对同一种数值只取匹配到的最大一条
    for (const [a, kind, v, f] of rig.m) if (a === act && inFilter(f, gid, cid)) best[kind] = Math.max(best[kind] || 0, v);
    const k = rig.sec[secCol(sec)] ?? 1;
    for (const [kind, v] of Object.entries(best)) mul[kind] *= 1 - (v * k) / 100;
  }
  const pct = (m) => Math.round((1 - m) * 1e4) / 100;
  return { me: pct(mul.me), te: pct(mul.te), cost: pct(mul.cost) };
}
// 税率：反应用 r，制造用 m，发明 / 拷贝 / 研究用 i
export const taxOf = (s, act, fallback) => {
  const v = s.tax?.[act === 'm' ? 'm' : act === 'r' ? 'r' : 'i'];
  return v == null || v === '' ? fallback : Number(v);
};

// 可装在这座建筑上的改装件（尺寸与分组都要对）；rp = true 只要化矿改装件
function rigOptions(s, rp = false) {
  const h = hull(s);
  if (!h) return [];
  return Object.entries(RD.data.rigs).filter(([, r]) => r.size === h.size && r.fit.includes(h.g) && (!rp || r.rp))
    .map(([id, r]) => [Number(id), r.n]).sort((a, b) => a[1].localeCompare(b[1], 'zh'));
}
export const rpRigOptions = (type) => rigOptions({ type }, true);

// ---------- 化矿与装配（不依赖制造页） ----------
export const rigData = () => RD.data;
export const hullOf = (type) => RD.data?.hulls[type] || null;
export const isRpService = (type) => Boolean(RD.data?.rpSvc?.includes(Number(type)));
// 建筑的基础化矿率（不含技能，SDE）：提炼设施三类（矿石 / 卫星矿 / 冰矿）默认 50%，化矿改装件把对应类别设为 数值 × 安全等级倍数
//   （同类有多个取最高），再乘船体加成；碎铁固定 50%。type 建筑类型，rigs 改装件，sec 星系安全等级
export function reprocBase(type, rigs, sec) {
  const col = secCol(sec ?? 0.5);
  const base = [0.5, 0.5, 0.5], set = [false, false, false];
  for (const rid of rigs || []) {
    const r = RD.data?.rigs[rid];
    if (!r?.rp) continue;
    const v = r.rp[0] * (r.sec[col] ?? 1);
    ['o', 'm', 'i'].forEach((c, i) => { if (r.rp[1].includes(c)) { base[i] = set[i] ? Math.max(base[i], v) : v; set[i] = true; } });
  }
  const k = 1 + (RD.data?.hulls[type]?.rp || 0) / 100;
  return { ore: base.map((v) => Math.round(v * k * 1e6) / 1e6), scrap: 0.5 };
}
// 改装件加成（乘好安全等级倍数）：工业 [[活动, 种类, 减免 %]]（同种取最大），化矿 [化矿率, 类别] 或 null
export function rigEffects(rid, sec) {
  const r = RD.data?.rigs[rid];
  if (!r) return null;
  const k = r.sec[secCol(sec ?? 0.5)] ?? 1;
  const best = new Map();
  for (const [a, kind, v] of r.m) { const key = a + ':' + kind; best.set(key, Math.max(best.get(key) || 0, v)); }
  return {
    ind: [...best].map(([key, v]) => [...key.split(':'), Math.round(v * k * 100) / 100]),
    rp: r.rp ? [Math.round(r.rp[0] * k * 1e4) / 1e4, r.rp[1]] : null,
    k
  };
}
// 军团建筑装配：军团资产里位置是建筑本身、栏位为各槽位的物品（含装填的弹药）。需要军团资产权限与总监职位；按军团缓存 5 分钟
// 返回 Map(位置 ID -> [{ t 类型, f 栏位, q 数量 }])（军团舰船的装配也在里面，调用方按建筑 ID 取）
export const FIT_FLAG = /^(HiSlot|MedSlot|LoSlot|RigSlot|ServiceSlot|FighterTube)\d$|^QuantumCoreRoom$/;
const FITS = new Map();   // 军团 ID -> { at, promise }
export function corpFittings(c, corp, fresh = false) {
  const hit = FITS.get(corp);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60e3) return hit.promise;
  const promise = c.esiAuthFetchPaged(`/corporations/${corp}/assets/`, 50).then((assets) => {
    const out = new Map();
    for (const a of assets || []) {
      if (!FIT_FLAG.test(a.location_flag || '')) continue;
      if (!out.has(a.location_id)) out.set(a.location_id, []);
      out.get(a.location_id).push({ t: a.type_id, f: a.location_flag, q: a.quantity || 1 });
    }
    return out;
  });
  FITS.set(corp, { at: Date.now(), promise });
  promise.catch(() => { if (FITS.get(corp)?.promise === promise) FITS.delete(corp); });
  return promise;
}

function upsert(item) {
  const cur = all();
  const old = item.id ? cur.find((s) => s.id === item.id) : null;
  if (old) {
    // 已有的建筑：名称 / 类型 / 星系以 ESI 为准；改装件只在读到时覆盖；税率保留
    Object.assign(old, { name: item.name || old.name, type: item.type || old.type, system: item.system || old.system });
    if (item.rigs) { old.rigs = item.rigs; old.rigSrc = item.rigSrc; }
    if (item.src === 'corp') old.src = 'corp';
    return old;
  }
  const s = { key: item.id ? String(item.id) : 'm' + Date.now().toString(36), rigs: [], tax: {}, src: 'manual', ...item };
  cur.push(s);
  return s;
}

// ---------- ESI ----------
const token = () => X.ctx.readToken?.();
const hasScope = (sc) => Boolean(token()?.access_token && X.ctx.hasScope?.(token(), sc));

async function structInfo(id) {
  const map = X.ctx.structureNameMap?.();
  const v = map?.get(id);
  if (v?.n && v.t) return { name: v.n, system: v.s, type: v.t };
  try {
    const info = await X.ctx.esiAuthFetch(`/universe/structures/${id}/`);
    map?.set(id, { n: info.name, s: info.solar_system_id, t: info.type_id, at: Date.now() });
    X.ctx.saveStructureNames?.();
    return { name: info.name, system: info.solar_system_id, type: info.type_id };
  } catch { return null; }
}

// 输入：建筑 ID、showinfo 链接或全名（名称要有建筑搜索权限）
async function parseInput(text) {
  const ids = new Set();
  for (const m of text.matchAll(/showinfo:\d+\/\/(\d{13,})/g)) ids.add(Number(m[1]));
  for (const m of text.replace(/showinfo:\d+\/\/\d+/g, ' ').matchAll(/\b(1\d{12,})\b/g)) ids.add(Number(m[1]));
  const names = text.replace(/<[^>]+>/g, '\n').replace(/showinfo:\S+/g, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 3 && !/^\d+$/.test(s));
  const misses = [];
  for (const n of names.slice(0, 10)) {
    const lower = n.toLowerCase();
    let hit = [...(X.ctx.structureNameMap?.() || [])].filter(([, v]) => v?.n && v.n.toLowerCase() === lower).map(([id]) => id);
    if (!hit.length && hasScope(JP.STRUCTURE_SEARCH_SCOPE)) {
      const r = await X.ctx.esiAuthFetch(`/characters/${token().character_id}/search/?categories=structure&search=${encodeURIComponent(n)}`).catch(() => null);
      hit = (r?.structure || []).slice(0, 5);
    }
    if (hit.length) hit.forEach((id) => ids.add(id)); else misses.push(n);
  }
  return { ids: [...ids], misses };
}

async function addByIds(ids, src = 'esi') {
  let added = 0, skipped = 0;
  for (const id of ids) {
    const info = await structInfo(id);
    if (!info || !RD.data.hulls[info.type]) { skipped += 1; continue; }
    upsert({ id, ...info, src });
    added += 1;
  }
  save();
  return { added, skipped };
}

// 军团建筑 + 改装件（军团资产里位置是建筑、栏位 RigSlot* 的物品）
async function corpStructs() {
  const cid = token().character_id;
  const corp = (await X.ctx.fetchESI(`/characters/${cid}/`)).corporation_id;
  const rows = await X.ctx.esiAuthFetchPaged(`/corporations/${corp}/structures/`, 5);
  const mine = rows.filter((s) => RD.data.hulls[s.type_id]);
  let rigs = null, rigErr = '';
  if (mine.length) {
    if (!hasScope(ASSET_SCOPE)) rigErr = '没有军团资产权限';
    else {
      try {
        const fits = await corpFittings(X.ctx, corp, true);
        rigs = new Map();
        for (const s of mine) {
          const r = (fits.get(s.structure_id) || []).filter((x) => /^RigSlot\d/.test(x.f)).map((x) => x.t);
          if (r.length) rigs.set(s.structure_id, r);
        }
      } catch (e) { rigErr = e.status === 403 ? '读不到军团资产（需要董事职位）' : '军团资产读取失败'; }
    }
  }
  for (const s of mine) {
    const r = rigs ? (rigs.get(s.structure_id) || []).filter((id) => RD.data.rigs[id]) : null;
    upsert({ id: s.structure_id, name: s.name || '', type: s.type_id, system: s.system_id, src: 'corp', ...(r ? { rigs: r, rigSrc: 'esi' } : {}) });
  }
  save();
  return { n: mine.length, withRigs: rigs ? mine.filter((s) => rigs.has(s.structure_id)).length : 0, rigErr };
}

// 扫描：军团建筑、自己制造任务用过的建筑、跳跃规划发现的能停靠的工业建筑（后两者列出来让你挑）
const FOUND = { list: [], busy: false, msg: '' };
async function scan(onMsg) {
  const notes = [];
  if (hasScope(CORP_STRUCT_SCOPE)) {
    onMsg('读取军团建筑…');
    try {
      const r = await corpStructs();
      notes.push(`军团建筑 ${r.n} 座${r.n ? `，读到改装件 ${r.withRigs} 座` : ''}${r.rigErr ? `（${r.rigErr}，改装件请手动选）` : ''}`);
    } catch (e) { notes.push(e.status === 403 ? '军团建筑要「空间站管理员」职位' : '军团建筑读取失败'); }
  }
  const cand = new Set();
  onMsg('读取制造任务…');
  try {
    const jobs = await X.ctx.esiAuthFetch(`/characters/${token().character_id}/industry/jobs/?include_completed=true`);
    for (const j of jobs || []) if (j.facility_id > 1e12) cand.add(j.facility_id);
  } catch { /* 没有工业任务权限 */ }
  try {
    const found = await JP.loadPublicStructures(X.ctx.ensureEsiToken, (d, t) => onMsg(`查找你能停靠的建筑 ${d}/${t}…`));
    for (const s of found.private || []) if (RD.data.hulls[s.type]) cand.add(s.id);
  } catch { /* 发现失败时只用任务里的建筑 */ }
  const have = new Set(all().map((s) => s.id));
  const out = [];
  let i = 0;
  for (const id of cand) {
    onMsg(`读取建筑详情 ${++i}/${cand.size}…`);
    if (have.has(id)) continue;
    const info = await structInfo(id);
    if (info && RD.data.hulls[info.type]) out.push({ id, ...info });
  }
  FOUND.list = out;
  notes.push(out.length ? `另找到 ${out.length} 座能停靠的工业建筑` : '没有找到其他能停靠的工业建筑');
  return notes.join('；');
}

// ---------- 管理对话框 ----------
let modal = null;
let msg = '';
export function openManager() {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'isTitle');
    modal.innerHTML = `<div class="modal-backdrop" data-is-close></div>
      <div class="modal-content sm-modal is-modal">
        <div class="modal-header"><h3 id="isTitle">我的建筑</h3>
          <button class="modal-close" data-is-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body" id="isBody"></div>
      </div>`;
    document.body.appendChild(modal);
    bind();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopImmediatePropagation(); close(); } }, true);
  }
  modal.hidden = false;
  loadRigs().then(render, () => { modal.querySelector('#isBody').innerHTML = '<p class="pi-note">改装件数据读取失败</p>'; });
}
function close() { modal.hidden = true; X.onChange(); }

function card(s) {
  const { esc } = X.ctx;
  const h = hull(s);
  const hulls = Object.entries(RD.data.hulls).sort((a, b) => a[1].g - b[1].g || a[1].size - b[1].size);
  const rigOpts = rigOptions(s);
  const rigSel = (i) => `<select class="pi-input" data-is-rig="${i}"><option value="">无改装件</option>${rigOpts.map(([id, n]) => `<option value="${id}"${s.rigs?.[i] === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  const sys = X.D.sys.get(s.system);
  const idx = X.D.indices.get(s.system) || {};
  const m = bonus({ ...s, rigs: [] }, 'm');
  const tag = s.src === 'corp' ? '军团' : s.src === 'esi' ? 'ESI' : '手动';
  return `<li class="is-card" data-is-key="${esc(s.key)}">
    <div class="is-row">
      <input class="pi-input is-name" data-is-f="name" value="${esc(s.name || '')}" placeholder="${esc(h?.n || '名称')}">
      <span class="sm-badge ok">${tag}</span>
      <button class="icon-btn small" data-is-del title="移除" aria-label="移除">✕</button>
    </div>
    <div class="is-grid">
      <label><span>类型</span><select class="pi-input" data-is-f="type">${hulls.map(([id, x]) => `<option value="${id}"${Number(id) === s.type ? ' selected' : ''}>${esc(x.n)}</option>`).join('')}</select></label>
      <label><span>星系</span><input class="pi-input" data-is-f="system" value="${esc(sys?.name || '')}" placeholder="星系名" list="isSysList"></label>
      <label><span>制造税 %</span><input type="number" class="pi-input" min="0" max="50" step="0.1" data-is-tax="m" value="${s.tax?.m ?? ''}" placeholder="—"></label>
      <label><span>反应税 %</span><input type="number" class="pi-input" min="0" max="50" step="0.1" data-is-tax="r" value="${s.tax?.r ?? ''}" placeholder="—"${canDo(s, 'r') ? '' : ' disabled'}></label>
      <label><span>科研税 %</span><input type="number" class="pi-input" min="0" max="50" step="0.1" data-is-tax="i" value="${s.tax?.i ?? ''}" placeholder="—"></label>
    </div>
    <div class="is-rigs">${[0, 1, 2].map(rigSel).join('')}</div>
    <small class="pi-hint">${sys ? X.sysLabel(s.system) + ` · 制造指数 ${((idx.manufacturing || 0) * 100).toFixed(2)}%` + (canDo(s, 'r') ? ` · 反应指数 ${((idx.reaction || 0) * 100).toFixed(2)}%` : '') : '星系未识别'}${m.me || m.te ? ` · 船体 ME −${m.me}% TE −${m.te}%` : ''}${s.rigSrc === 'esi' ? ' · 改装件读自军团资产' : ''}</small>
  </li>`;
}

function render() {
  if (!modal || modal.hidden) return;
  const { esc } = X.ctx;
  const body = modal.querySelector('#isBody');
  const esi = Boolean(token()?.access_token);
  const cur = structs();
  const found = FOUND.list.filter((f) => !cur.some((s) => s.id === f.id));
  const sysNames = [...X.D.sys.values()].map((s) => `<option value="${esc(s.name)}">`).join('');
  body.innerHTML = `
    <div class="sm-actions">
      <button class="btn btn-primary" data-is-new>手动添加</button>
      ${esi ? `<button class="btn" data-is-scan ${FOUND.busy ? 'disabled' : ''}>${FOUND.busy ? '扫描中…' : '扫描军团与能停靠的建筑'}</button>` : '<span class="text-muted">绑定 ESI 后可读取建筑与改装件</span>'}
      <span class="sm-progress">${esc(msg)}</span>
    </div>
    ${esi ? `<div class="sm-add"><textarea class="pi-input" data-is-input rows="2" placeholder="${esc(tr('按建筑 ID、游戏内链接或全名添加，一行一个'))}"></textarea><button class="btn" data-is-add>读取</button></div>` : ''}
    ${found.length ? `<ul class="sm-list is-found">${found.map((f) => `<li class="sm-row"><span class="sm-name">${esc(f.name)}<small>${esc(RD.data.hulls[f.type].n)} · ${esc(X.D.sys.get(f.system)?.name || '')}</small></span><button class="btn btn-ghost" data-is-pick="${f.id}">添加</button></li>`).join('')}</ul>` : ''}
    ${cur.length ? `<ul class="is-list">${cur.map(card).join('')}</ul>` : '<p class="sm-sum">还没有建筑</p>'}
    <datalist id="isSysList">${sysNames}</datalist>`;
}

function itemOf(el) { const li = el.closest('[data-is-key]'); return li ? all().find((s) => s.key === li.dataset.isKey) : null; }

function bind() {
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('[data-is-close]')) { close(); return; }
    if (e.target.closest('[data-is-new]')) {
      upsert({ name: '', type: 35825, system: X.D.sys.has(X.F.sys) ? X.F.sys : 0, src: 'manual' });
      save(); render();
      modal.querySelector('.is-list .is-card:last-child .is-name')?.focus();
      return;
    }
    if (e.target.closest('[data-is-scan]')) {
      FOUND.busy = true; msg = ''; render();
      try { msg = await scan((t) => { const p = modal.querySelector('.sm-progress'); if (p) p.textContent = t; }); } catch (err) { msg = '扫描失败：' + err.message; }
      FOUND.busy = false; render();
      return;
    }
    if (e.target.closest('[data-is-add]')) {
      const text = modal.querySelector('[data-is-input]').value.trim();
      if (!text) return;
      msg = '读取中…'; render();
      try {
        const { ids, misses } = await parseInput(text);
        const r = ids.length ? await addByIds(ids) : { added: 0, skipped: 0 };
        msg = (r.added ? `添加了 ${r.added} 座` : '没有添加') + (r.skipped ? `；${r.skipped} 座读不到或不是工业建筑` : '') + (misses.length ? `；找不到：${misses.slice(0, 3).join('、')}` : '');
      } catch (err) { msg = '读取失败：' + err.message; }
      render();
      return;
    }
    const pick = e.target.closest('[data-is-pick]');
    if (pick) {
      const f = FOUND.list.find((x) => x.id === Number(pick.dataset.isPick));
      if (f) { upsert({ ...f, src: 'esi' }); save(); render(); }
      return;
    }
    if (e.target.closest('[data-is-del]')) {
      const s = itemOf(e.target);
      if (s) { list = all().filter((x) => x !== s); save(); render(); }
    }
  });
  modal.addEventListener('change', (e) => {
    const t = e.target;
    const s = itemOf(t);
    if (!s) return;
    if (t.dataset.isF === 'name') s.name = t.value.trim();
    else if (t.dataset.isF === 'type') { s.type = Number(t.value); const ok = new Set(rigOptions(s).map(([id]) => id)); s.rigs = (s.rigs || []).filter((id) => ok.has(id)); }
    else if (t.dataset.isF === 'system') {
      const q = t.value.trim().toLowerCase();
      const hit = [...X.D.sys.values()].find((x) => x.name.toLowerCase() === q);
      if (hit) s.system = hit.id; else { msg = '没有这个星系：' + t.value.trim(); }
    } else if (t.dataset.isRig != null) {
      const rigs = [0, 1, 2].map((i) => s.rigs?.[i] || 0);
      rigs[Number(t.dataset.isRig)] = Number(t.value) || 0;
      s.rigs = rigs.filter(Boolean);
      s.rigSrc = 'manual';
    } else if (t.dataset.isTax) {
      const v = t.value.trim();
      s.tax = { ...(s.tax || {}), [t.dataset.isTax]: v === '' ? '' : Math.min(50, Math.max(0, Number(v) || 0)) };
    } else return;
    save(); render();
  });
}
