// ===== 模拟装配 · 深渊装备自定义属性（突变）=====
// 数据：mutaplasmid-data.json（build_mutaplasmids.mjs 由 SDE dynamicItemAttributes 生成）：每种突变质体能改的属性与倍率范围、
//   可用的原装备、突变后得到的深渊装备。
// 装配里的突变装备存为 { type: 深渊装备, mut: { base: 原装备, mutator: 突变质体, attrs: { 属性ID: 值 } } }，
//   计算时属性取原装备、再用 attrs 覆盖（fit-engine.js）。每项属性只能在「原装备值 × [最小倍率, 最大倍率]」之间取值，与游戏一致。
// EFT 文本与 Pyfa 相同：装备行写「原装备名 [n]」，文末另起「[n] 原装备名 / 突变质体名 / 属性名 值, …」。
// 宁静服：属性表下方是参考估价卡片（套用的在售装备且属性未改时取它的 MutaMarket 估价，否则按当前属性用本站模型）；
// 点「深渊市场在售」才读取并以卡片列出同类在售装备（MutaMarket，/api/v1/abyssal/list），可对比属性、一键套用。
//   存为装备的 abyssal: { value, src: 'item'（MutaMarket）| 'model'（本站模型）| 'similar', item, include }，include 时计入装配估价。
import { IS_TQ, SERVER } from './server.js?v=s3';

let app, FE;
let D = null;        // 解析后的数据
let loading = null;
const $ = (id) => document.getElementById(id);

export function initMutate(context, engine) { app = context; FE = engine; }

export function loadMuta() {
  if (D) return Promise.resolve(D);
  if (!loading) {
    loading = fetch('mutaplasmid-data.json?v=1').then((r) => { if (!r.ok) throw new Error('突变质体数据 ' + r.status); return r.json(); }).then((raw) => {
      const list = raw.muta.map(([id, name, en, attrs, bases, result]) => ({ id, name, en, attrs: attrs.map(([attr, min, max, good]) => ({ attr, min, max, good })), bases, result }));
      const byBase = new Map(), byResult = new Map(), byName = new Map();
      for (const m of list) {
        for (const b of m.bases) { if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(m); }
        if (!byResult.has(m.result)) byResult.set(m.result, []);
        byResult.get(m.result).push(m);
        byName.set(m.name.toLowerCase(), m);
        if (m.en) byName.set(m.en.toLowerCase(), m);
      }
      const attrByName = new Map(Object.entries(raw.attrs).map(([id, a]) => [a[2].toLowerCase(), Number(id)]));
      D = { list, byId: new Map(list.map((m) => [m.id, m])), byBase, byResult, byName, attrs: raw.attrs, units: raw.units, attrByName };
      return D;
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}
export const ready = () => D;

// 装配里的这件装备能否突变 / 是否是未设属性的深渊装备
export function canMutate(m) {
  if (!D || !m) return false;
  return Boolean(m.mut || D.byBase.has(m.type) || D.byResult.has(m.type));
}
export const isBareAbyssal = (m) => Boolean(D && m && !m.mut && D.byResult.has(m.type));

// 某原装备可用的突变质体；深渊装备（没有原装备信息）时列出能突变出它的全部原装备
function mutasForBase(base) { return D.byBase.get(base) || []; }
function basesForResult(result) {
  const set = new Set();
  for (const m of D.byResult.get(result) || []) for (const b of m.bases) set.add(b);
  return [...set].filter((b) => FE.data().types.has(b));
}

// 显示值与原始值的换算（毫秒显示为秒，倍率类显示为百分比）
function toShow(v, unit) {
  switch (unit) {
    case 101: return v / 1000;
    case 108: case 111: return (1 - v) * 100;
    case 109: return (v - 1) * 100;
    case 127: return v * 100;
    default: return v;
  }
}
function fromShow(v, unit) {
  switch (unit) {
    case 101: return v * 1000;
    case 108: case 111: return 1 - v / 100;
    case 109: return 1 + v / 100;
    case 127: return v / 100;
    default: return v;
  }
}
const unitLabel = (unit) => (unit === 101 ? '秒' : [108, 109, 111, 127].includes(unit) ? '%' : D.units[unit] || '');
const round = (v) => Number(Number(v).toPrecision(6));
// 相对原装备的变化：负值属性（如缠绕光束 -60%）按幅度算，-62.1 相对 -60 记为 +3.5%
const change = (v, b) => (b ? (b < 0 ? (Math.abs(v) - Math.abs(b)) / Math.abs(b) : (v - b) / Math.abs(b)) : 0);
const fmtNum = (v) => { const a = Math.abs(v); return Number(v.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4)).toLocaleString('zh-CN', { maximumFractionDigits: 4 }); };

// ---------- 编辑弹窗 ----------
const E = { m: null, base: 0, muta: null, values: {}, onApply: null,
  aby: null,        // 套用的在售装备 { item, value, values }（属性改动后不再算这件）
  include: false,   // 参考估价计入装配总价
  list: null,       // 在售列表 { type, state: 'loading' | 'ok' | 'error', items, error }
  sameBase: false, sort: 'near',
  showMarket: false, lastEst: null };    // 本站模型估价 { key, state: 'loading' | 'ok' | 'error', value, stats, error }

function baseValue(id) {
  const t = FE.data().types.get(E.base);
  return t?.attrs.has(id) ? t.attrs.get(id) : FE.data().attrs.get(id)?.def ?? 0;
}
function rangeOf(a) {
  const b = baseValue(a.attr);
  const x = b * a.min, y = b * a.max;
  return [Math.min(x, y), Math.max(x, y), b];
}
function goodHigh(a) { return a.good === -1 ? Boolean(FE.data().attrs.get(a.attr)?.highIsGood) : a.good === 1; }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function presetValues(kind) {
  const out = {};
  for (const a of E.muta.attrs) {
    const [lo, hi, b] = rangeOf(a);
    out[a.attr] = kind === 'best' ? (goodHigh(a) ? hi : lo) : kind === 'worst' ? (goodHigh(a) ? lo : hi) : kind === 'random' ? lo + Math.random() * (hi - lo) : clamp(b, lo, hi);
  }
  return out;
}

function render() {
  const data = FE.data();
  const tn = (id) => data.types.get(id)?.name || D.byId.get(id)?.name || String(id);
  const mutas = mutasForBase(E.base);
  const bases = E.m.mut || !D.byResult.has(E.m.type) ? null : basesForResult(E.m.type);
  const rows = E.muta ? E.muta.attrs.map((a) => {
    const meta = D.attrs[a.attr] || [String(a.attr), 0];
    const unit = meta[1];
    const [lo, hi, b] = rangeOf(a);
    const v = clamp(E.values[a.attr] ?? b, lo, hi);
    const pct = change(v, b);
    const better = Math.abs(v - b) < 1e-9 ? null : goodHigh(a) ? v > b : v < b;
    const step = (hi - lo) / 1000 || 1;
    const sLo = toShow(lo, unit), sHi = toShow(hi, unit);
    const u = app.esc(unitLabel(unit));
    return `<tr>
      <td title="原装备 ${fmtNum(toShow(b, unit))} ${u}"><b>${app.esc(meta[0])}</b></td>
      <td class="mut-slider" title="${fmtNum(Math.min(sLo, sHi))} – ${fmtNum(Math.max(sLo, sHi))} ${u}（× ${a.min} – ${a.max}）"><input type="range" min="${lo}" max="${hi}" step="${step}" value="${v}" data-mut-range="${a.attr}" aria-label="${app.esc(meta[0])}"></td>
      <td><input type="number" class="cr-input" step="any" value="${round(toShow(v, unit))}" data-mut-num="${a.attr}" aria-label="${app.esc(meta[0])}数值"> ${u}</td>
      <td class="${better == null ? '' : better ? 'up' : 'down'}">${better == null ? '—' : (pct > 0 ? '+' : '') + (pct * 100).toFixed(2) + '%'}</td></tr>`;
  }).join('') : '';
  $('mutBody').innerHTML = `
    <div class="mut-top">
      ${bases ? `<label class="mut-field" title="这件深渊装备没有突变记录，先选它突变前的原装备"><span>原装备</span><select class="cr-input" data-mut-base>${bases.sort((x, y) => tn(x).localeCompare(tn(y), 'zh')).map((b) => `<option value="${b}"${b === E.base ? ' selected' : ''}>${app.esc(tn(b))}</option>`).join('')}</select></label>`
        : `<div class="mut-field"><span>原装备</span><b>${app.esc(tn(E.base))}</b></div>`}
      <label class="mut-field"><span>突变质体</span><select class="cr-input" data-mut-muta>${mutas.map((m) => `<option value="${m.id}"${m.id === E.muta?.id ? ' selected' : ''}>${app.esc(m.name)}</option>`).join('')}</select></label>
    </div>
    ${E.muta ? `<div class="mut-presets"><button class="btn btn-ghost" data-mut-preset="base">原始值</button><button class="btn btn-ghost" data-mut-preset="best">全部最佳</button><button class="btn btn-ghost" data-mut-preset="worst">全部最差</button><button class="btn btn-ghost" data-mut-preset="random">随机</button></div>
      <div class="table-scroll"><table class="pc-mini-table mut-table"><thead><tr><th>属性</th><th>范围</th><th>数值</th><th>相对原装备</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${abySupported() ? `<div class="mut-est" id="mutEst">${estimateHtml()}</div><div id="mutMarket">${E.showMarket ? marketHtml() : ''}</div>` : ''}`
      : '<p class="text-muted">这件装备没有可用的突变质体</p>'}
    <div class="mut-actions">
      ${E.m.mut ? '<button class="btn btn-ghost" data-mut-clear>取消突变</button>' : ''}
      <span class="toolbar-spacer"></span>
      <button class="btn btn-ghost" data-mut-close>取消</button>
      <button class="btn btn-primary" data-mut-apply${E.muta ? '' : ' disabled'}>应用到装配</button>
    </div>`;
}
const tname = (id) => FE.data().types.get(id)?.name || D.byId.get(id)?.name || String(id);
// 只重绘估价卡片 / 在售列表，不动属性表（拖动滑块时不打断）
function refreshEst() { if ($('mutEst')) $('mutEst').innerHTML = estimateHtml(); }
function refreshMarket() { if ($('mutMarket')) $('mutMarket').innerHTML = E.showMarket ? marketHtml() : ''; }

// ---------- 深渊市场在售对比与参考估价 ----------
const abySupported = () => IS_TQ && SERVER.kb;
function loadList() {
  const type = E.muta?.result;
  if (!type || !abySupported() || (E.list && E.list.type === type && E.list.state !== 'error')) return;
  E.list = { type, state: 'loading', items: [] };
  fetch(`/api/v1/abyssal/list?type=${type}&sort=date-added&order=desc`).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error?.message || 'HTTP ' + r.status);
    return body.items;
  }).then((items) => { if (E.list?.type === type) E.list = { type, state: 'ok', items }; })
    .catch((e) => { if (E.list?.type === type) E.list = { type, state: 'error', items: [], error: e.message }; })
    .finally(() => { if (!$('mutModal')?.hidden && E.list?.type === type) { refreshMarket(); refreshEst(); } });
}
const listAttr = (x, id) => x.attributes.find((a) => a.id === id)?.value;
// 与当前属性的距离：每项按本突变质体的取值范围归一化后求均方根
function distance(x) {
  let sum = 0, n = 0;
  for (const a of E.muta.attrs) {
    const v = listAttr(x, a.attr);
    if (v == null) continue;
    const [lo, hi, b] = rangeOf(a);
    sum += ((v - (E.values[a.attr] ?? b)) / ((hi - lo) || 1)) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : Infinity;
}
// 本站模型（只在 MutaMarket 没有估价时用）：自定义属性 → 服务器上按类型训练的随机森林
function modelAttrs() {
  const t = FE.data().types.get(E.base);
  const out = t ? Object.fromEntries(t.attrs) : {};
  for (const a of E.muta.attrs) out[a.attr] = E.values[a.attr] ?? baseValue(a.attr);
  return out;
}
let modelTimer = 0;
function requestModel() {
  if (!abySupported() || !E.muta) return null;
  const type = E.muta.result;
  const attrs = modelAttrs();
  const key = type + ':' + E.muta.attrs.map((a) => attrs[a.attr]).join(',') + ':' + E.base;
  if (E.model?.key === key) return E.model;
  E.model = { key, state: 'loading' };
  clearTimeout(modelTimer);
  modelTimer = setTimeout(() => {
    fetch('/api/v1/abyssal/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ type_id: type, attrs, source_type_id: E.base }] }) })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error?.message || 'HTTP ' + r.status);
        const x = body.results?.[0] || {};
        if (x.value == null) throw new Error(x.error || '暂无本站模型');
        return { key, state: 'ok', value: x.value, stats: x.model };
      })
      .catch((e) => ({ key, state: 'error', error: e.message }))
      .then((res) => {
        if (E.model?.key !== key) return;
        E.model = res;
        if (!$('mutModal')?.hidden) refreshEst();
      });
  }, 350);
  return E.model;
}
const sameValues = (a, b) => E.muta.attrs.every((x) => Math.abs((a[x.attr] ?? 0) - (b[x.attr] ?? 0)) <= Math.abs(b[x.attr] ?? 0) * 1e-6 + 1e-9);
function estimate() {
  if (E.aby && sameValues(E.values, E.aby.values) && E.aby.value) return { value: E.aby.value, src: 'item', item: E.aby.item };
  const m = requestModel();
  if (m?.state === 'ok') return { value: m.value, src: 'model', stats: m.stats };
  if (m?.state === 'loading') return { loading: true };
  if (E.list?.state !== 'ok') return null;
  const near = E.list.items.filter((x) => x.estimated_value).map((x) => [distance(x), x]).filter(([d]) => Number.isFinite(d)).sort((a, b) => a[0] - b[0]).slice(0, 5);
  if (!near.length) return null;
  const vals = near.map(([, x]) => x.estimated_value).sort((a, b) => a - b);
  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  return { value: mid, src: 'similar', n: vals.length, dist: near[near.length - 1][0] };
}
const confText = (r2) => (r2 >= 0.85 ? '很高' : r2 >= 0.7 ? '高' : r2 >= 0.5 ? '中' : r2 >= 0.3 ? '低' : '很低');
function estimateHtml() {
  const est = estimate();
  const ok = est && !est.loading;
  if (ok) E.lastEst = est.value;
  const v = ok ? est.value : est?.loading ? E.lastEst : null;   // 估算中保留上一个数，卡片不跳
  const st = est?.stats;
  const src = est?.loading ? '估算中…' : !est ? (E.list?.state === 'loading' ? '读取中…' : '暂无估价')
    : est.src === 'item' ? 'MutaMarket 估价' : est.src === 'model' ? `本站模型${st ? ' · 可信度' + confText(st.r2) : ''}` : `相似在售 ${est.n} 件中位数`;
  const tip = est?.src === 'model' && st ? `按当前属性估算 · ${st.data_count} 条合同数据 · R² ${st.r2.toFixed(2)} · 平均误差 ${Math.round(st.nmae)}%`
    : est?.src === 'item' ? '套用的在售装备，属性未改' : '';
  return `<div class="mut-est-main"><span>参考估价</span><b>${v ? app.formatISK(v) + ' ISK' : '—'}</b><small${tip ? ` title="${app.esc(tip)}"` : ''}>${src}</small></div>
    <label class="mut-check"><input type="checkbox" data-mut-include${E.include ? ' checked' : ''}${v ? '' : ' disabled'}>计入总价</label>
    <button class="btn btn-sm${E.showMarket ? ' btn-primary' : ''}" data-mut-market>深渊市场在售</button>`;
}
function cardHtml(x) {
  const attrs = E.muta.attrs.map((a) => {
    const v = listAttr(x, a.attr);
    if (v == null) return '';
    const unit = (D.attrs[a.attr] || [])[1];
    const [, , b] = rangeOf(a);
    const cur = E.values[a.attr] ?? b;
    const same = Math.abs(v - cur) <= Math.abs(cur) * 1e-6 + 1e-12;
    const better = same ? null : goodHigh(a) ? v > cur : v < cur;
    const d = change(toShow(v, unit), toShow(cur, unit));   // 按显示值算（抗性显示为抗性百分比）
    return `<div class="aby-attr ${better == null ? '' : better ? 'up' : 'down'}"><span class="aby-attr-name">${app.esc((D.attrs[a.attr] || [String(a.attr)])[0])}</span>
      <span class="aby-attr-val">${fmtNum(toShow(v, unit))} ${app.esc(unitLabel(unit))}</span><span class="aby-attr-delta">${same ? '相同' : (d > 0 ? '+' : '') + (d * 100).toFixed(1) + '%'}</span></div>`;
  }).join('');
  const c = x.contract;
  const extra = c ? (c.abyssal_modules_count || 1) - 1 + (c.non_abyssal_modules_count || 0) : 0;
  const src = x.source_type?.id;
  return `<article class="aby-mcard mut-card${E.aby?.item === x.item_id ? ' active' : ''}">
    <header><img src="https://images.evetech.net/types/${src || x.type_id}/icon?size=32" alt="" width="32" height="32" loading="lazy">
      <div><b>${app.esc(tname(src))}</b><small>${app.esc(D.byId.get(x.mutaplasmid?.id)?.name || x.mutaplasmid?.name || '')}</small></div></header>
    <div class="aby-attrs">${attrs}</div>
    <footer><span class="aby-price"><b>${c?.price ? app.formatISK(c.price) : x.listed ? '议价' : '—'}</b>${extra > 0 ? `<em class="mut-plus" title="合同里还有 ${extra} 件其它物品">+${extra}</em>` : ''}</span>
      <span class="aby-est">估 <b>${x.estimated_value ? app.formatISK(x.estimated_value) : '—'}</b></span></footer>
    <div class="mut-card-act"><button class="btn btn-sm" data-mut-use="${x.item_id}">套用</button><a class="btn btn-ghost btn-sm" href="#abyss/m/${x.item_id}" target="_blank" rel="noopener">详情</a></div>
  </article>`;
}
function marketHtml() {
  loadList();
  const L = E.list;
  let body;
  if (!L || L.state === 'loading') body = '<p class="text-muted">读取中…</p>';
  else if (L.state === 'error') body = `<p class="text-muted">读取失败：${app.esc(L.error)} <button class="btn btn-ghost btn-sm" data-mut-reload>重试</button></p>`;
  else {
    let items = L.items.filter((x) => !E.sameBase || x.source_type?.id === E.base).map((x) => ({ x, d: distance(x) }));
    if (E.sort === 'near') items.sort((a, b) => a.d - b.d);
    else if (E.sort === 'price') items = items.filter((r) => r.x.contract?.price).sort((a, b) => a.x.contract.price - b.x.contract.price);
    else if (E.sort === 'value') items.sort((a, b) => (b.x.estimated_value || 0) - (a.x.estimated_value || 0));
    const cards = items.slice(0, 24).map(({ x }) => cardHtml(x)).join('');
    body = `<div class="mut-mk-bar">
        <label class="mut-check"><input type="checkbox" data-mut-samebase${E.sameBase ? ' checked' : ''}>相同原装备</label>
        <span class="toolbar-spacer"></span>
        <div class="segmented">${[['near', '最接近'], ['price', '最便宜'], ['value', '估价最高']].map(([k, l]) => `<button type="button" data-mut-sort="${k}" class="${E.sort === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      ${cards ? `<div class="aby-grid mut-grid">${cards}</div>` : '<p class="text-muted">没有符合条件的在售装备</p>'}`;
  }
  return `<div class="mut-market">
    <div class="mut-mk-head"><h4>在售 · ${app.esc(tname(E.muta.result))}</h4><a class="btn btn-ghost btn-sm" href="#abyss/t/${E.muta.result}" target="_blank" rel="noopener">深渊市场 ↗</a></div>
    ${body}</div>`;
}
function useListing(id) {
  const x = E.list?.items.find((i) => i.item_id === id);
  if (!x) return;
  const base = x.source_type?.id;
  if (base && FE.data().types.has(base) && mutasForBase(base).some((m) => m.id === x.mutaplasmid?.id)) E.base = base;
  if (mutasForBase(E.base).some((m) => m.id === x.mutaplasmid?.id)) setMuta(x.mutaplasmid.id);
  for (const a of E.muta.attrs) {
    const v = listAttr(x, a.attr);
    if (v != null) { const [lo, hi] = rangeOf(a); E.values[a.attr] = clamp(v, lo, hi); }
  }
  E.aby = { item: x.item_id, value: x.estimated_value, values: { ...E.values } };
  if (x.estimated_value) E.include = true;
  render();
}

function setMuta(id) {
  const prev = E.muta?.result;
  E.muta = D.byId.get(Number(id)) || null;
  if (E.muta?.result !== prev) E.lastEst = null;
  const keep = E.values;
  E.values = {};
  if (E.muta) for (const a of E.muta.attrs) { const [lo, hi, b] = rangeOf(a); E.values[a.attr] = clamp(keep[a.attr] ?? b, lo, hi); }
}

function ensureModal() {
  if ($('mutModal')) return;
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'mutModal';
  modal.hidden = true;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `<div class="modal-backdrop" data-mut-close></div><div class="modal-content mut-modal">
    <div class="modal-header"><h3 id="mutTitle">深渊装备自定义属性</h3><button class="modal-close" data-mut-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <div class="modal-body" id="mutBody"></div></div>`;
  document.body.appendChild(modal);
  const close = () => { modal.hidden = true; };
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-mut-close]')) { close(); return; }
    const p = e.target.closest('[data-mut-preset]');
    if (p) { E.values = presetValues(p.dataset.mutPreset); render(); return; }
    if (e.target.closest('[data-mut-clear]')) { E.onApply({ type: E.base, mut: null, abyssal: null }); close(); return; }
    const use = e.target.closest('[data-mut-use]');
    if (use) { useListing(Number(use.dataset.mutUse)); return; }
    const so = e.target.closest('[data-mut-sort]');
    if (so) { E.sort = so.dataset.mutSort; refreshMarket(); return; }
    if (e.target.closest('[data-mut-reload]')) { E.list = null; refreshMarket(); return; }
    if (e.target.closest('[data-mut-market]')) { E.showMarket = !E.showMarket; refreshMarket(); refreshEst(); return; }
    if (e.target.closest('[data-mut-apply]')) {
      const attrs = {};
      for (const a of E.muta.attrs) { const [lo, hi] = rangeOf(a); attrs[a.attr] = round(clamp(E.values[a.attr], lo, hi)); }
      const result = FE.data().types.has(E.muta.result) ? E.muta.result : E.base;
      const est = estimate();
      if (est?.loading) { app.showToast?.('本站模型还在估算，请稍候', 'info'); return; }
      E.onApply({ type: result, mut: { base: E.base, mutator: E.muta.id, attrs }, abyssal: est ? { value: Math.round(est.value), src: est.src, item: est.item || null, include: E.include } : null });
      close();
    }
  });
  modal.addEventListener('input', (e) => {
    const r = e.target.closest('[data-mut-range]');
    if (!r) return;
    const id = Number(r.dataset.mutRange);
    E.values[id] = Number(r.value);
    // 拖动时只更新本行的数字与变化，不重绘整张表（保持拖动）
    const row = r.closest('tr');
    const a = E.muta.attrs.find((x) => x.attr === id);
    const unit = (D.attrs[id] || [])[1];
    const [, , b] = rangeOf(a);
    const v = E.values[id];
    row.querySelector('[data-mut-num]').value = round(toShow(v, unit));
    const pct = change(v, b);
    const better = Math.abs(v - b) < 1e-9 ? null : goodHigh(a) ? v > b : v < b;
    const cell = row.lastElementChild;
    cell.className = better == null ? '' : better ? 'up' : 'down';
    cell.textContent = better == null ? '—' : (pct > 0 ? '+' : '') + (pct * 100).toFixed(2) + '%';
    refreshEst();
  });
  modal.addEventListener('change', (e) => {
    const n = e.target.closest('[data-mut-num]');
    if (n) {
      const id = Number(n.dataset.mutNum);
      const a = E.muta.attrs.find((x) => x.attr === id);
      const [lo, hi] = rangeOf(a);
      const raw = fromShow(Number(n.value), (D.attrs[id] || [])[1]);
      if (Number.isFinite(raw)) E.values[id] = clamp(raw, lo, hi);
      render();
      return;
    }
    if (e.target.matches('[data-mut-include]')) { E.include = e.target.checked; return; }
    if (e.target.matches('[data-mut-samebase]')) { E.sameBase = e.target.checked; refreshMarket(); return; }
    if (e.target.matches('[data-mut-muta]')) { setMuta(e.target.value); render(); return; }
    if (e.target.matches('[data-mut-base]')) {
      E.base = Number(e.target.value);
      const keep = E.muta?.id;
      const list = mutasForBase(E.base);
      setMuta(list.some((m) => m.id === keep) ? keep : list[0]?.id);
      render();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) { e.stopImmediatePropagation(); close(); } }, true);
}

// 打开编辑：m 为装配里的装备，onApply({ type, mut }) 回写
export async function openMutate(m, onApply) {
  await loadMuta();
  ensureModal();
  E.m = m;
  E.onApply = onApply;
  E.values = { ...(m.mut?.attrs || {}) };
  E.include = Boolean(m.abyssal?.include);
  E.showMarket = false;
  E.lastEst = null;
  E.aby = m.abyssal?.src === 'item' && m.abyssal.item ? { item: m.abyssal.item, value: m.abyssal.value, values: { ...(m.mut?.attrs || {}) } } : null;
  if (m.mut) E.base = m.mut.base;
  else if (D.byResult.has(m.type)) {
    // 深渊装备没有原装备信息：默认选名字带 II 的（T2）或第一个
    const bases = basesForResult(m.type);
    const tn = (id) => FE.data().types.get(id)?.name || '';
    E.base = bases.find((b) => /II$/.test(tn(b))) || bases[0];
  } else E.base = m.type;
  const list = mutasForBase(E.base);
  const pick = m.mut?.mutator && list.some((x) => x.id === m.mut.mutator) ? m.mut.mutator
    : (D.byResult.get(m.type) || []).find((x) => x.bases.includes(E.base))?.id || list[0]?.id;
  setMuta(pick);
  $('mutTitle').textContent = '深渊装备自定义属性 · ' + (FE.data().types.get(m.type)?.name || '');
  render();
  $('mutModal').hidden = false;
}

// ---------- EFT ----------
// 导出：返回 { name(m), tail }；name 为装备行名字（突变装备写原装备名 + [n]），tail 为文末的突变段
export function eftWriter(en) {
  const blocks = [];
  return {
    name(m) {
      if (!m.mut || !D) return en(m.type);
      blocks.push(m);
      return `${en(m.mut.base)} [${blocks.length}]`;
    },
    tail() {
      return blocks.map((m, i) => {
        const muta = D.byId.get(m.mut.mutator);
        const attrs = Object.entries(m.mut.attrs).map(([id, v]) => [D.attrs[id]?.[2] || id, v]).sort((a, b) => a[0].localeCompare(b[0])).map(([n, v]) => `${n} ${round(v)}`).join(', ');
        return `[${i + 1}] ${en(m.mut.base)}\n  ${muta?.en || muta?.name || m.mut.mutator}\n  ${attrs}`;
      }).join('\n\n');
    }
  };
}

// 导入：从 EFT 文本里取出突变段，返回 { lines: 去掉突变段后的行, refs: Map(n -> { base, mutator, attrs }) }
export function eftReader(lines, findType) {
  const refs = new Map();
  if (!D) return { lines, refs };
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const head = /^\[(\d+)\]\s+(.+)$/.exec(raw);
    if (head) { cur = { n: Number(head[1]), base: findType(head[2])?.id || null, mutator: null, attrs: {} }; refs.set(cur.n, cur); continue; }
    if (cur && raw) {
      const muta = D.byName.get(raw.toLowerCase());
      if (muta) { cur.mutator = muta.id; continue; }
      const pairs = raw.split(',').map((x) => /^\s*([A-Za-z][\w]*)\s+(-?[\d.]+(?:e-?\d+)?)\s*$/.exec(x)).filter(Boolean);
      if (pairs.length) { for (const [, name, v] of pairs) { const id = D.attrByName.get(name.toLowerCase()); if (id) cur.attrs[id] = Number(v); } continue; }
    }
    if (!raw) cur = null;
    if (!cur) out.push(raw);
  }
  return { lines: out, refs };
}

// 装备行「名字 [n]」→ { name, ref }
export function splitRef(name) {
  const m = /^(.*?)\s*\[(\d+)\]$/.exec(name);
  return m ? { name: m[1], ref: Number(m[2]) } : { name, ref: null };
}

// 由突变段得到装配里的装备字段
export function mutFromRef(r, fallbackBase) {
  if (!D || !r) return null;
  const base = r.base || fallbackBase;
  const muta = D.byId.get(r.mutator) || (D.byBase.get(base) || [])[0];
  if (!base || !muta) return null;
  const t = FE.data().types.get(base);
  const attrs = {};
  for (const a of muta.attrs) {
    const b = t?.attrs.get(a.attr) ?? FE.data().attrs.get(a.attr)?.def ?? 0;
    const lo = Math.min(b * a.min, b * a.max), hi = Math.max(b * a.min, b * a.max);
    attrs[a.attr] = round(clamp(r.attrs[a.attr] ?? b, lo, hi));
  }
  return { type: FE.data().types.has(muta.result) ? muta.result : base, mut: { base, mutator: muta.id, attrs } };
}

// 突变属性的简短说明（装备行提示用）
export function mutSummary(m) {
  if (!D || !m.mut) return '';
  const aby = m.abyssal?.value ? `\n参考估价：${app.formatISK(m.abyssal.value)} ISK（${({ item: 'MutaMarket 估价', model: '本站模型' })[m.abyssal.src] || '相似在售装备'}${m.abyssal.include ? '，已计入装配总价' : ''}）` : '';
  const t = FE.data().types.get(m.mut.base);
  const muta = D.byId.get(m.mut.mutator);
  return `${muta?.name || ''}\n原装备：${t?.name || ''}\n` + Object.entries(m.mut.attrs).map(([id, v]) => {
    const meta = D.attrs[id] || [id, 0];
    const b = t?.attrs.get(Number(id)) ?? 0;
    return `${meta[0]}：${fmtNum(toShow(v, meta[1]))} ${unitLabel(meta[1])}${b ? `（${change(v, b) >= 0 ? '+' : ''}${(change(v, b) * 100).toFixed(1)}%）` : ''}`;
  }).join('\n') + aby;
}
