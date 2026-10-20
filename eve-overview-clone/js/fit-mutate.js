// ===== 模拟装配 · 深渊装备自定义属性（突变）=====
// 数据：mutaplasmid-data.json（build_mutaplasmids.mjs 由 SDE dynamicItemAttributes 生成）：每种突变质体能改的属性与倍率范围、
//   可用的原装备、突变后得到的深渊装备。
// 装配里的突变装备存为 { type: 深渊装备, mut: { base: 原装备, mutator: 突变质体, attrs: { 属性ID: 值 } } }，
//   计算时属性取原装备、再用 attrs 覆盖（fit-engine.js）。每项属性只能在「原装备值 × [最小倍率, 最大倍率]」之间取值，与游戏一致。
// EFT 文本与 Pyfa 相同：装备行写「原装备名 [n]」，文末另起「[n] 原装备名 / 突变质体名 / 属性名 值, …」。

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
const E = { m: null, base: 0, muta: null, values: {}, onApply: null };

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
    return `<tr>
      <td><b>${app.esc(meta[0])}</b><small>原装备 ${fmtNum(toShow(b, unit))} ${app.esc(unitLabel(unit))}</small></td>
      <td class="mut-slider"><input type="range" min="${lo}" max="${hi}" step="${step}" value="${v}" data-mut-range="${a.attr}" aria-label="${app.esc(meta[0])}">
        <small>${fmtNum(Math.min(sLo, sHi))} – ${fmtNum(Math.max(sLo, sHi))}（× ${a.min} – ${a.max}）</small></td>
      <td><input type="number" class="cr-input" step="any" value="${round(toShow(v, unit))}" data-mut-num="${a.attr}" aria-label="${app.esc(meta[0])}数值"> ${app.esc(unitLabel(unit))}</td>
      <td class="${better == null ? '' : better ? 'up' : 'down'}">${better == null ? '—' : (pct > 0 ? '+' : '') + (pct * 100).toFixed(2) + '%'}</td></tr>`;
  }).join('') : '';
  $('mutBody').innerHTML = `
    ${bases ? `<label class="mut-field"><span>原装备</span><select class="cr-input" data-mut-base>${bases.sort((x, y) => tn(x).localeCompare(tn(y), 'zh')).map((b) => `<option value="${b}"${b === E.base ? ' selected' : ''}>${app.esc(tn(b))}</option>`).join('')}</select></label>
      <p class="mut-note">这件深渊装备没有突变记录（来自游戏装配或击杀邮件），先选它突变前的原装备。</p>` : `<p class="mut-note">原装备：<b>${app.esc(tn(E.base))}</b></p>`}
    <label class="mut-field"><span>突变质体</span><select class="cr-input" data-mut-muta>${mutas.map((m) => `<option value="${m.id}"${m.id === E.muta?.id ? ' selected' : ''}>${app.esc(m.name)}</option>`).join('')}</select></label>
    ${E.muta ? `<div class="mut-presets"><button class="btn btn-ghost" data-mut-preset="base">原始值</button><button class="btn btn-ghost" data-mut-preset="best">全部最佳</button><button class="btn btn-ghost" data-mut-preset="worst">全部最差</button><button class="btn btn-ghost" data-mut-preset="random">随机</button></div>
      <div class="table-scroll"><table class="pc-mini-table mut-table"><thead><tr><th>属性</th><th>取值范围</th><th>数值</th><th>相对原装备</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="mut-note">突变后得到：<b>${app.esc(tn(E.muta.result))}</b>。每项只能在「原装备值 × 倍率范围」内取值，与游戏一致；绿色表示比原装备好，红色表示更差。</p>` : '<p class="text-muted">这件装备没有可用的突变质体</p>'}
    <div class="mut-actions">
      ${E.m.mut ? '<button class="btn btn-ghost" data-mut-clear>取消突变（恢复原装备）</button>' : ''}
      <span class="toolbar-spacer"></span>
      <button class="btn btn-ghost" data-mut-close>取消</button>
      <button class="btn btn-primary" data-mut-apply${E.muta ? '' : ' disabled'}>应用到装配</button>
    </div>`;
}

function setMuta(id) {
  E.muta = D.byId.get(Number(id)) || null;
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
    if (e.target.closest('[data-mut-clear]')) { E.onApply({ type: E.base, mut: null }); close(); return; }
    if (e.target.closest('[data-mut-apply]')) {
      const attrs = {};
      for (const a of E.muta.attrs) { const [lo, hi] = rangeOf(a); attrs[a.attr] = round(clamp(E.values[a.attr], lo, hi)); }
      const result = FE.data().types.has(E.muta.result) ? E.muta.result : E.base;
      E.onApply({ type: result, mut: { base: E.base, mutator: E.muta.id, attrs } });
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
  const t = FE.data().types.get(m.mut.base);
  const muta = D.byId.get(m.mut.mutator);
  return `${muta?.name || ''}\n原装备：${t?.name || ''}\n` + Object.entries(m.mut.attrs).map(([id, v]) => {
    const meta = D.attrs[id] || [id, 0];
    const b = t?.attrs.get(Number(id)) ?? 0;
    return `${meta[0]}：${fmtNum(toShow(v, meta[1]))} ${unitLabel(meta[1])}${b ? `（${change(v, b) >= 0 ? '+' : ''}${(change(v, b) * 100).toFixed(1)}%）` : ''}`;
  }).join('\n');
}
