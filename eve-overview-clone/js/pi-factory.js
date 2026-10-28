// ===== 行星工业：工厂计算 =====
// 买料加工的工厂星：选产品、工厂数量、从哪一级原料开始加工，算出
//   1. 最大补货周期：发射平台（+ 仓库）装得下的最长加工时间。原料随加工减少、产品随之增加，
//      t 时刻存量 = 原料体积速率 ×（T - t）+ 产品体积速率 × t，最大值出现在开头或结尾，所以 T 最长 = 容量 / max(原料, 产品体积速率)；
//   2. 自定义加工时间：按整数个生产周期算出每种原料的需求量、产品产量、成本与收益，一键加入购物车（游戏「批量购买」）或复制清单。
// 中间产品（从 P1 / P0 开始加工时）按数量逐级倒推：每级按整批（配方产量）向上取整。
// 数据来自 pi-planner.js 的 pi-data.json（配方、物品体积），价格为默认交易中心实时价。

let ctx, env;   // ctx: esc, formatISK, formatNumber, showToast, store, getHubPrices, addToCart；env: pi, schemByOut, cName, tierOf, ICON, TAX_BASE, HUB_NAME
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-pi-factory-v1';
const LP_CAP = 10000, STORAGE_CAP = 12000;   // 发射平台、仓库容量 m³
const PRESETS = [[0, '最大'], [12, '12 时'], [24, '1 天'], [48, '2 天'], [96, '4 天'], [168, '7 天']];
const TIER_NAMES = ['P0 原材料', 'P1 基础产品', 'P2 精炼产品', 'P3 特种产品', 'P4 高级产品'];

const S = {
  product: 0, factories: 10, from: 0,   // from：原料从哪一级开始（0 = 直接用配方的原料）
  pads: 1, storages: 0, hours: 0,       // hours = 0 表示按最大周期
  inPrice: 'sell', outPrice: 'sell', tax: 10
};
let prices = new Map(), priceAt = 0;

export function initFactory(context, environment) {
  ctx = context; env = environment;
  Object.assign(S, ctx.store.getJSON(STORE_KEY, {}));
}
const save = () => ctx.store.setJSON(STORE_KEY, S);
const esc = (s) => ctx.esc(s ?? '');
const vol = (id) => env.pi.commodities[id]?.[3] || 0;
const nf = (n, d = 0) => ctx.formatNumber(d ? Math.round(n * 10 ** d) / 10 ** d : Math.round(n));

// 产品改由侧栏选择时调用
export function setProduct(id) {
  if (!env.schemByOut.has(id)) return;
  S.product = id;
  if (S.from >= env.tierOf(id) - 1) S.from = 0;   // 原料等级必须比配方原料更低
  save();
}

// ---------- 计算 ----------
// 产品链：从产品往下展开到原料等级 from（0 = 不展开）。返回 { steps: Map(产物 -> 需要的工厂数), leaves: Map(原料 -> 每小时) }
function rates(product, factories, from) {
  const steps = new Map(), leaves = new Map();
  const walk = (id, perHour) => {
    const s = env.schemByOut.get(id);
    const expand = s && (id === product || (from && env.tierOf(id) > from));
    if (!expand) { leaves.set(id, (leaves.get(id) || 0) + perHour); return; }
    const runs = perHour / (s.outQty * 3600 / s.cycle);   // 等效满负荷工厂数
    steps.set(id, (steps.get(id) || 0) + runs);
    for (const [inId, qty] of s.inputs) walk(inId, runs * qty * 3600 / s.cycle);
  };
  const top = env.schemByOut.get(product);
  walk(product, factories * top.outQty * 3600 / top.cycle);
  return { steps, leaves };
}
// 加工 hours 小时：顶层工厂各做 floor(hours / 周期) 批，中间产品按整批向上取整，得到每种原料的数量
function amounts(product, factories, from, hours) {
  const top = env.schemByOut.get(product);
  const batches = Math.floor(hours * 3600 / top.cycle + 1e-9);
  const out = factories * batches * top.outQty;
  const need = new Map(), leaves = new Map();
  const add = (m, id, q) => m.set(id, (m.get(id) || 0) + q);
  for (const [id, qty] of top.inputs) add(need, id, factories * batches * qty);
  // 中间产品按等级从高到低展开，同一中间产品合并后再取整
  while (need.size) {
    const [id] = [...need.keys()].sort((a, b) => env.tierOf(b) - env.tierOf(a));
    const q = need.get(id);
    need.delete(id);
    const s = env.schemByOut.get(id);
    if (s && from && env.tierOf(id) > from) {
      const runs = Math.ceil(q / s.outQty);
      for (const [inId, qty] of s.inputs) add(need, inId, runs * qty);
    } else add(leaves, id, q);
  }
  return { batches, out, leaves };
}
function calc() {
  const p = S.product, top = env.schemByOut.get(p);
  const { steps, leaves } = rates(p, S.factories, S.from);
  const outRate = S.factories * top.outQty * 3600 / top.cycle;
  const inVol = [...leaves].reduce((a, [id, r]) => a + r * vol(id), 0);
  const outVol = outRate * vol(p);
  const cap = S.pads * LP_CAP + S.storages * STORAGE_CAP;
  const maxHours = cap / Math.max(inVol, outVol, 1e-9);
  // 最大周期取整到顶层配方的生产周期
  const cycleH = top.cycle / 3600;
  const maxRun = Math.floor(maxHours / cycleH + 1e-9) * cycleH;
  const hours = S.hours > 0 ? S.hours : maxRun;
  const a = amounts(p, S.factories, S.from, hours);
  const peak = a.out * vol(p) > [...a.leaves].reduce((x, [id, q]) => x + q * vol(id), 0) ? 'out' : 'in';
  const peakVol = Math.max(a.out * vol(p), [...a.leaves].reduce((x, [id, q]) => x + q * vol(id), 0));
  return { p, top, steps, leaves, outRate, inVol, outVol, cap, maxHours, maxRun, cycleH, hours, a, peak, peakVol };
}

async function loadPrices(ids) {
  const miss = ids.filter((id) => !prices.has(id));
  if (!miss.length && Date.now() - priceAt < 300e3) return;
  const got = await ctx.getHubPrices(ids);
  for (const [id, v] of got) prices.set(id, v);
  priceAt = Date.now();
}
const priceOf = (id, side) => prices.get(id)?.[side] || 0;
const tax = (id, half) => env.TAX_BASE[env.tierOf(id)] * S.tax / 100 * (half ? 0.5 : 1);

// ---------- 显示 ----------
const dur = (h) => {
  if (!isFinite(h)) return '不限';
  const d = Math.floor(h / 24), r = h - d * 24, hh = Math.floor(r), m = Math.round((r - hh) * 60);
  return (d ? d + ' 天 ' : '') + (hh || !d ? hh + ' 小时' : '') + (m ? ' ' + m + ' 分' : '');
};
const seg = (name, items, cur) => `<div class="segmented" role="group">${items.map(([v, label]) => `<button type="button" data-pf-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${label}</button>`).join('')}</div>`;

export function renderFactory(box) {
  if (!box.dataset.ready) { box.dataset.ready = '1'; bind(box); }
  if (!env.schemByOut.has(S.product)) S.product = [...env.schemByOut.keys()].find((id) => env.tierOf(id) === 2) || [...env.schemByOut.keys()][0];
  const tier = env.tierOf(S.product);
  const products = [1, 2, 3, 4].map((t) => {
    const ids = [...env.schemByOut.keys()].filter((id) => env.tierOf(id) === t).sort((a, b) => env.cName(a).localeCompare(env.cName(b), 'zh'));
    return `<optgroup label="${TIER_NAMES[t]}">${ids.map((id) => `<option value="${id}"${S.product === id ? ' selected' : ''}>${esc(env.cName(id))}</option>`).join('')}</optgroup>`;
  }).join('');
  const froms = [[0, '配方原料（P' + (tier - 1) + '）'], ...[1, 0].filter((t) => t < tier - 1).map((t) => [t === 0 ? -1 : t, `从 P${t} 开始`])];
  box.innerHTML = `
    <div class="pi-layout pf-layout">
      <form class="pi-form" id="pfForm" autocomplete="off" onsubmit="return false">
        <div class="pi-col">
          <div class="pi-field"><label>产品</label><select class="pi-input" data-pf-num="product">${products}</select></div>
          <div class="pi-field"><label>原料</label>${seg('from', froms, S.from)}
            <small class="pi-hint">从更低一级开始时，同一颗行星上加建中间产品工厂</small></div>
        </div>
        <div class="pi-col">
          <div class="pi-field"><label>工厂与仓储</label>
            <div class="pi-grid3">
              <div class="pi-num"><span>产品工厂</span><input type="number" class="pi-input" min="1" max="200" value="${S.factories}" data-pf-num="factories"></div>
              <div class="pi-num"><span>发射平台</span><select class="pi-input" data-pf-num="pads">${[1, 2, 3, 4].map((n) => `<option value="${n}"${S.pads === n ? ' selected' : ''}>${n} 个</option>`).join('')}</select></div>
              <div class="pi-num"><span>仓库</span><select class="pi-input" data-pf-num="storages">${[0, 1, 2, 3, 4].map((n) => `<option value="${n}"${S.storages === n ? ' selected' : ''}>${n} 个</option>`).join('')}</select></div>
            </div>
            <small class="pi-hint">发射平台 ${nf(LP_CAP)} m³，仓库 ${nf(STORAGE_CAP)} m³</small></div>
        </div>
        <div class="pi-col">
          <div class="pi-field"><label>加工时间</label>${seg('hours', PRESETS, PRESETS.some(([h]) => h === S.hours) ? S.hours : '')}
            <div class="pi-inline"><span>自定义</span><input type="number" class="pi-input pi-tax" min="0" step="0.5" value="${S.hours || ''}" placeholder="小时" data-pf-num="hours"><span>小时</span></div></div>
        </div>
        <div class="pi-col">
          <div class="pi-field"><label>价格与税</label>
            <div class="pi-inline"><span>原料价</span>${seg('inPrice', [['sell', env.HUB_NAME + '卖单'], ['buy', env.HUB_NAME + '收单']], S.inPrice)}</div>
            <div class="pi-inline"><span>售价</span>${seg('outPrice', [['sell', env.HUB_NAME + '卖单'], ['buy', env.HUB_NAME + '收单']], S.outPrice)}</div>
            <div class="pi-inline"><span>海关税率</span><input type="number" class="pi-input pi-tax" min="0" max="100" step="0.5" value="${S.tax}" data-pf-num="tax"><span>%</span></div></div>
        </div>
      </form>
      <div class="pi-result" id="pfResult"></div>
    </div>`;
  renderResult();
}

async function renderResult() {
  const el = $('pfResult');
  if (!el) return;
  const r = calc();
  const ids = [r.p, ...r.a.leaves.keys()];
  el.innerHTML = resultHtml(r, false);
  try { await loadPrices(ids); } catch { /* 没有价格也能算数量 */ }
  if ($('pfResult') === el) el.innerHTML = resultHtml(r, true);
}

function resultHtml(r, priced) {
  const icon = (id) => `<img src="${env.ICON(id)}" alt="" width="24" height="24" loading="lazy">`;
  const leaves = [...r.a.leaves].sort((a, b) => env.tierOf(b[0]) - env.tierOf(a[0]) || b[1] - a[1]);
  const over = S.hours > 0 && r.peakVol > r.cap + 1e-6;
  const inCost = leaves.reduce((a, [id, q]) => a + q * priceOf(id, S.inPrice), 0);
  const inTax = leaves.reduce((a, [id, q]) => a + q * tax(id, true), 0);
  const outVal = r.a.out * priceOf(r.p, S.outPrice);
  const outTax = r.a.out * tax(r.p, false);
  const profit = outVal - inCost - inTax - outTax;
  const perDay = r.hours > 0 ? profit / r.hours * 24 : 0;
  const steps = [...r.steps].filter(([id]) => id !== r.p);
  const isk = (v) => (priced && v ? ctx.formatISK(v) : '—');
  return `
    <div class="pf-summary">
      <div class="pi-card pf-stat"><span>最大补货周期</span><b class="${r.maxRun ? '' : 'down'}">${r.maxRun ? dur(r.maxRun) : '不足 1 个周期'}</b>
        <small>容量 ${nf(r.cap)} m³ ÷ 每小时 ${nf(Math.max(r.inVol, r.outVol), 1)} m³（${r.outVol > r.inVol ? '产品体积大于原料，按产品' : '按原料'}）${!r.maxRun ? `，只装得下 ${nf(r.maxHours * 60)} 分钟的原料，请增加发射平台 / 仓库或减少工厂` : r.maxRun < r.maxHours - 1e-6 ? `，取整到 ${nf(r.cycleH, 2)} 小时的生产周期` : ''}</small></div>
      <div class="pi-card pf-stat"><span>本次加工</span><b>${dur(r.hours)}</b><small>每个产品工厂 ${nf(r.a.batches)} 批 · 共产出 ${nf(r.a.out)} 个</small></div>
      <div class="pi-card pf-stat"><span>体积峰值</span><b class="${over ? 'down' : ''}">${nf(r.peakVol)} m³</b><small>${over ? `超出容量 ${nf(r.cap)} m³，需要 ${Math.ceil(r.peakVol / LP_CAP)} 个发射平台，或中途补货 / 取货` : `${r.peak === 'out' ? '结束时（产品）' : '开始时（原料）'}，占容量 ${nf(r.peakVol / r.cap * 100, 1)}%`}</small></div>
      <div class="pi-card pf-stat"><span>预计利润</span><b class="${profit < 0 ? 'down' : 'up'}">${priced ? ctx.formatISK(profit) : '—'}</b><small>${priced ? `每天 ${ctx.formatISK(perDay)} · 已扣进出口税` : '读取价格中…'}</small></div>
    </div>
    <div class="pi-card pf-card">
      <div class="pf-card-head"><h3>原料需求<small>${dur(r.hours)} · ${S.factories} 个产品工厂</small></h3><span class="toolbar-spacer"></span>
        <button type="button" class="btn btn-primary btn-sm" data-pf-buy ${leaves.length ? '' : 'disabled'}>一键购买</button>
        <button type="button" class="btn btn-ghost btn-sm" data-pf-copy>复制批量购买清单</button></div>
      <table class="data-table pf-table"><thead><tr><th>原料</th><th>每小时</th><th>数量</th><th>体积 m³</th><th>单价</th><th>金额</th><th>进口税</th></tr></thead><tbody>
        ${leaves.map(([id, q]) => `<tr><td>${icon(id)}<span>${esc(env.cName(id))}</span><small>P${env.tierOf(id)}</small></td><td>${nf(r.leaves.get(id) || 0, 1)}</td><td><b>${nf(q)}</b></td><td>${nf(q * vol(id), 1)}</td>
          <td>${isk(priceOf(id, S.inPrice))}</td><td>${isk(q * priceOf(id, S.inPrice))}</td><td>${isk(q * tax(id, true))}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>合计</td><td></td><td></td><td>${nf(leaves.reduce((a, [id, q]) => a + q * vol(id), 0), 1)}</td><td></td><td>${isk(inCost)}</td><td>${isk(inTax)}</td></tr></tfoot></table>
    </div>
    <div class="pi-card pf-card">
      <h3>产出与工厂</h3>
      <table class="data-table pf-table"><thead><tr><th>产物</th><th>工厂数</th><th>每小时</th><th>数量</th><th>体积 m³</th><th>金额</th></tr></thead><tbody>
        <tr><td>${icon(r.p)}<span>${esc(env.cName(r.p))}</span><small>P${env.tierOf(r.p)}</small></td><td>${S.factories}</td><td>${nf(r.outRate, 1)}</td><td><b>${nf(r.a.out)}</b></td><td>${nf(r.a.out * vol(r.p), 1)}</td><td>${isk(outVal)}${priced && outTax ? `<small class="text-muted">出口税 ${ctx.formatISK(outTax)}</small>` : ''}</td></tr>
        ${steps.map(([id, n]) => `<tr class="pf-mid"><td>${icon(id)}<span>${esc(env.cName(id))}</span><small>中间产品</small></td><td title="满负荷需要 ${nf(n, 2)} 个">${Math.ceil(n - 1e-9)}<small class="text-muted">（${nf(n, 2)}）</small></td><td>${nf(n * env.schemByOut.get(id).outQty * 3600 / env.schemByOut.get(id).cycle, 1)}</td><td colspan="3" class="text-muted">在行星上加工后直接使用</td></tr>`).join('')}
      </tbody></table>
      <p class="pi-hint pf-note">按整数个生产周期计算：每个工厂必须凑齐一整批原料才开工，中间产品按整批向上取整。中间产品工厂括号里是满负荷所需的理论数量，取整后会略有空闲。中间产品的加工也需要时间，实际首批产品会稍晚产出。</p>
    </div>`;
}

function buyList() {
  const r = calc();
  return [...r.a.leaves].filter(([, q]) => q > 0).map(([id, q]) => ({ id, qty: Math.ceil(q), name: env.cName(id), en: env.pi.commodities[id]?.[1] }));
}

function bind(box) {
  box.addEventListener('click', (e) => {
    const set = e.target.closest('[data-pf-set]');
    if (set) {
      const k = set.dataset.pfSet, v = set.dataset.v;
      S[k] = ['from', 'hours'].includes(k) ? Number(v) : v;
      save();
      renderFactory(box);
      return;
    }
    if (e.target.closest('[data-pf-buy]')) {
      const list = buyList();
      if (!list.length) return;
      ctx.addToCart(list);
      return;
    }
    if (e.target.closest('[data-pf-copy]')) {
      const text = buyList().map((x) => `${x.name}\t${x.qty}`).join('\n');
      navigator.clipboard.writeText(text).then(() => ctx.showToast(`已复制 ${buyList().length} 项，在游戏市场「批量购买」里粘贴`, 'success'), () => ctx.showToast('复制失败，请检查浏览器的剪贴板权限', 'error'));
    }
  });
  box.addEventListener('change', (e) => {
    const el = e.target.closest('[data-pf-num]');
    if (!el) return;
    const k = el.dataset.pfNum;
    let v = Number(el.value);
    if (k === 'factories') v = Math.min(200, Math.max(1, Math.round(v) || 1));
    if (k === 'hours') v = Math.max(0, v || 0);
    if (k === 'tax') v = Math.min(100, Math.max(0, v || 0));
    if (k === 'product') { setProduct(v); renderFactory(box); return; }
    S[k] = v;
    save();
    renderFactory(box);
  });
}
