// ===== 击杀记录装配 =====
// 列出当前舰船最近 N 天阵亡时的装配（击杀记录服务 /api/kb/shipfits，最多分析最近 300 次损失），
// 只看装备时相同的装配合并为一组（弹药、无人机数量不同不影响），按出现次数排序，点「套用」载入装配页。
import { SERVER, NO_KB_MESSAGE } from './server.js?v=s4';
let ctx;   // data, FE, getFit, applyFit, esc, formatNumber, formatISK, showToast, store
const $ = (id) => document.getElementById(id);
const KEY = 'eve-fit-kb-days';
const IMG = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;
const DAYS = [1, 3, 7, 14, 30];
const K = { days: 7, groups: [], ship: 0, loading: 0 };

export function initKbFits(context) {
  ctx = context;
  K.days = Number(ctx.store.get(KEY)) || 7;
}

export function openKbFits() {
  let modal = $('fitKbModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'fitKbModal';
    modal.className = 'modal fa-modal';
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `<div class="modal-backdrop"></div><div class="modal-content fk-content">
      <div class="modal-header"><h3 id="fkTitle">击杀记录装配</h3><button class="modal-close" data-fk-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body"><div class="fk-bar" id="fkBar"></div><div class="fk-list" id="fkList"></div></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onClick);
  }
  modal.hidden = false;
  load();
}

function close() { const m = $('fitKbModal'); if (m) m.hidden = true; }

function renderBar(extra = '') {
  $('fkBar').innerHTML = `<div class="segmented">${DAYS.map((d) => `<button type="button" data-fk-days="${d}" class="${K.days === d ? 'active' : ''}">${d} 天</button>`).join('')}</div><span class="text-muted">${extra}</span>`;
}

async function load() {
  const ship = ctx.getFit().ship;
  const shipType = ctx.data.types.get(ship);
  $('fkTitle').textContent = `${shipType?.name || ''} · 击杀记录装配`;
  renderBar();
  const token = ++K.loading;
  $('fkList').innerHTML = '<div class="fa-empty">读取阵亡记录…（首次较慢）</div>';
  try {
    if (!SERVER.kb) throw new Error(NO_KB_MESSAGE);
    const r = await fetch(`/api/kb/shipfits?ship=${ship}&days=${K.days}`);
    if (!r.ok) throw new Error(r.status === 404 ? '需要击杀记录服务' : 'HTTP ' + r.status);
    const j = await r.json();
    if (token !== K.loading) return;
    K.groups = merge(j.fits || []);
    K.ship = ship;
    renderBar(j.total ? `${j.total} 次阵亡${j.scanned < j.total ? `，分析最近 ${j.scanned} 次` : ''} · ${K.groups.length} 种装配` : '');
    render();
  } catch (err) {
    if (token === K.loading) $('fkList').innerHTML = `<div class="fa-empty">读取失败：${ctx.esc(err.message)}</div>`;
  }
}

// 服务端按物品原样分组；这里拆出装备 / 弹药 / 无人机，按「只看装备」合并
function merge(fits) {
  const { data, FE } = ctx;
  const out = new Map();
  for (const g of fits) {
    const modules = {}, charges = {}, drones = new Map();
    for (const [slot, items] of Object.entries(g.fit)) {
      for (const [id, qty] of items) {
        const t = data.types.get(id);
        if (!t) continue;
        if (slot === 'drone' || slot === 'fighter') { if (t.category === FE.CAT.drone || t.category === 87) drones.set(id, (drones.get(id) || 0) + qty); continue; }
        if (t.slot) (modules[t.slot] ||= new Map()).set(id, (modules[t.slot].get(id) || 0) + qty);
        else if (t.category === FE.CAT.charge) (charges[slot] ||= new Map()).set(id, (charges[slot].get(id) || 0) + qty);
      }
    }
    const key = FE.SLOTS.map((s) => s + ':' + [...(modules[s] || new Map())].sort((a, b) => a[0] - b[0]).map((x) => x.join('x')).join(',')).join('|');
    if (!FE.SLOTS.some((s) => modules[s]?.size)) continue;
    let m = out.get(key);
    if (!m) { m = { modules, charges: {}, drones: new Map(), n: 0, last: 0, value: 0, ids: [] }; out.set(key, m); }
    m.value = (m.value * m.n + g.value * g.n) / (m.n + g.n);
    m.n += g.n;
    m.last = Math.max(m.last, g.last);
    if (m.ids.length < 5) m.ids.push(...g.ids.slice(0, 5 - m.ids.length));
    // 弹药与无人机：按出现次数累计，套用时取最常见的
    for (const [slot, map] of Object.entries(charges)) for (const [id] of map) { (m.charges[slot] ||= new Map()).set(id, (m.charges[slot].get(id) || 0) + g.n); }
    if (drones.size) { const k = [...drones].map((x) => x.join('x')).join(','); m.drones.set(k, { list: [...drones], n: (m.drones.get(k)?.n || 0) + g.n }); }
  }
  return [...out.values()].sort((a, b) => b.n - a.n || b.last - a.last);
}

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  return d < 3600 ? Math.max(1, Math.round(d / 60)) + ' 分钟前' : d < 86400 ? Math.round(d / 3600) + ' 小时前' : Math.round(d / 86400) + ' 天前';
}

function render() {
  const { esc, formatISK: isk, data, FE } = ctx;
  const name = (id) => data.types.get(id)?.name || id;
  const total = K.groups.reduce((t, g) => t + g.n, 0);
  $('fkList').innerHTML = K.groups.slice(0, 60).map((g, i) => {
    const slots = FE.SLOTS.map((s) => {
      const map = g.modules[s];
      if (!map?.size) return '';
      return `<div class="fa-slot"><span>${FE.SLOT_NAME[s]}</span><div>${[...map].map(([id, n]) => `<em title="${esc(name(id))}"><img src="${IMG(id)}" alt="" width="20" height="20" loading="lazy">${esc(name(id))}${n > 1 ? ` <b>×${n}</b>` : ''}</em>`).join('')}</div></div>`;
    }).join('');
    const drones = topDrones(g);
    return `<div class="fa-result fk-item">
      <div class="fa-result-head"><b>×${g.n}</b><span class="text-muted">${(g.n / total * 100).toFixed(0)}% · ${ago(g.last)} · 平均损失 ${isk(g.value)}</span>
        <a class="link-btn" href="https://zkillboard.com/kill/${g.ids[0]}/" target="_blank" rel="noopener">查看击杀</a>
        <button type="button" class="btn btn-primary" data-fk-apply="${i}">套用</button></div>
      ${slots}
      ${drones.length ? `<div class="fa-slot"><span>无人机</span><div>${drones.map(([id, n]) => `<em><img src="${IMG(id)}" alt="" width="20" height="20" loading="lazy">${esc(name(id))} <b>×${n}</b></em>`).join('')}</div></div>` : ''}
    </div>`;
  }).join('') || '<div class="fa-empty">没有阵亡记录</div>';
}

const topDrones = (g) => [...g.drones.values()].sort((a, b) => b.n - a.n)[0]?.list || [];

// 对战模拟（fit-sim.js）用：某型舰船最近 N 天（最近 limit 次损失里）最常见的装配（没有记录时为 null）
// kills：只看这些击杀（一场会战里这型船的实际损失）
export async function commonFit(ship, { days = 7, limit = 20, kills = null } = {}) {
  if (!SERVER.kb) throw new Error(NO_KB_MESSAGE);
  const r = await fetch(`/api/kb/shipfits?ship=${ship}&days=${days}&limit=${limit}${kills?.length ? '&kills=' + kills.slice(0, 60).join(',') : ''}`);
  if (!r.ok) throw new Error(r.status === 404 ? '需要击杀记录服务' : 'HTTP ' + r.status);
  const groups = merge((await r.json()).fits || []);
  if (!groups.length) return null;
  // list：全部装配分组（按出现次数），第一套即最常见的
  const list = groups.slice(0, 12).map((g) => ({ fit: toFit(g, ship, []), n: g.n }));
  return { ...list[0], list, total: groups.reduce((t, g) => t + g.n, 0) };
}

function toFit(g, ship = K.ship, implants = ctx.getFit()?.implants || []) {
  const { data, FE } = ctx;
  const fit = { id: null, name: '', ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [...implants] };
  for (const s of FE.SLOTS) {
    const charges = [...(g.charges[s] || new Map())].sort((a, b) => b[1] - a[1]).map(([id]) => data.types.get(id)).filter(Boolean);
    for (const [id, n] of g.modules[s] || []) {
      const t = data.types.get(id);
      const charge = charges.find((c) => FE.chargeFits(t, c));
      for (let k = 0; k < n; k++) fit.slots[s].push({ type: id, state: t.activatable ? 'active' : 'online', charge: charge ? charge.id : null });
    }
  }
  fit.drones = topDrones(g).map(([id, n]) => ({ type: id, count: n, active: 0 }));
  return fit;
}

function onClick(e) {
  if (e.target.closest('[data-fk-close]') || e.target.classList.contains('modal-backdrop')) { close(); return; }
  const d = e.target.closest('[data-fk-days]');
  if (d) { K.days = Number(d.dataset.fkDays); ctx.store.set(KEY, String(K.days)); load(); return; }
  const a = e.target.closest('[data-fk-apply]');
  if (a) {
    const g = K.groups[Number(a.dataset.fkApply)];
    const fit = toFit(g);
    fit.name = `击杀记录 ×${g.n}`;
    ctx.applyFit(fit, true);
    close();
    ctx.showToast('已套用击杀记录装配', 'success');
  }
}
