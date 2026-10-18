// ===== 合同估价 =====
// 粘贴游戏里复制的合同物品列表（或仓库、装配、货柜清单），按交易中心挂单估价：
// 每件物品的最低卖价、最高收价，合计「按卖单」「按收单」两种总价；收单量不够时另算按挂单深度能卖出的价值。
// 识别格式：制表符或两个以上空格分列，第一列物品名（游戏复制的名称后可能带 *），第二列数量；
// 也支持「名称 x 数量」「数量 x 名称」「名称 数量」和单独一行物品名。
import { SERVER } from './server.js?v=s1';

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, fetchESIPaged, getMarketPriceMap, getTypeIndex() -> Map(id -> { type }), regions
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-appraisal-v1';
const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

const A = { names: null, loading: null, orders: new Map(), result: null, hub: 10000002 };

export function initAppraisal(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {});
  if (ctx.regions.some((r) => r.id === saved.hub)) A.hub = saved.hub;
}

// 中文名 → typeID：用页面已载入的市场物品目录（不在市场上卖的物品本来也估不了价）
function loadNames() {
  if (!A.loading) {
    A.loading = ctx.getTypeIndex().then((index) => {
      if (!index.size) throw new Error('物品目录还没载入');
      const byName = new Map(), byId = {};
      for (const [id, { type }] of index) {
        byId[id] = type.name;
        if (!byName.has(norm(type.name))) byName.set(norm(type.name), id);
      }
      A.names = { byName, byId };
    }).catch((e) => { A.loading = null; throw e; });
  }
  return A.loading;
}

const norm = (s) => s.replace(/\*+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const num = (s) => {
  const t = String(s).replace(/[,\s '’]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
};

// 解析粘贴内容：返回 { items: Map(typeId -> 数量), unknown: [行] }
export function parse(text) {
  const items = new Map();
  const unknown = [];
  const add = (id, qty) => items.set(id, (items.get(id) || 0) + qty);
  const find = (name) => A.names.byName.get(norm(name)) || (/^\d+$/.test(name.trim()) && A.names.byId[name.trim()] ? Number(name.trim()) : null);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\t| {2,}/).map((c) => c.trim()).filter((c, i) => c || i === 0);
    let id = find(cols[0]);
    if (id) {
      add(id, cols.length > 1 && num(cols[1]) !== null ? num(cols[1]) || 1 : 1);
      continue;
    }
    // 名称 x 数量 / 数量 x 名称 / 名称 数量
    let m = /^(.+?)\s*[x×*]\s*([\d,]+)$/i.exec(line) || /^(.+?)\s+([\d,]+)$/.exec(line);
    if (m && (id = find(m[1]))) { add(id, num(m[2]) || 1); continue; }
    m = /^([\d,]+)\s*[x×]?\s+(.+)$/i.exec(line);
    if (m && (id = find(m[2]))) { add(id, num(m[1]) || 1); continue; }
    unknown.push(line);
  }
  return { items, unknown };
}

// 交易中心挂单：最低卖价、最高收价，以及按价格排好的收单（算深度用）
async function hubOrders(region, ids, onProgress) {
  const todo = ids.filter((id) => !A.orders.has(region.id + ':' + id));
  let done = ids.length - todo.length;
  onProgress(done, ids.length);
  const queue = todo.slice();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      let entry;
      try {
        const orders = (await ctx.fetchESIPaged(`/markets/${region.id}/orders/?order_type=all&type_id=${id}`)).filter((o) => o.location_id === region.hub.id);
        const sells = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
        const buys = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
        entry = { sell: sells[0]?.price ?? null, buy: buys[0]?.price ?? null, buys: buys.map((o) => [o.price, o.volume_remain, o.min_volume || 1]), sells: sells.map((o) => [o.price, o.volume_remain]) };
      } catch { entry = { failed: true }; }
      A.orders.set(region.id + ':' + id, entry);
      onProgress(++done, ids.length);
    }
  }));
}

// 按挂单深度成交 qty 件能得到 / 花费多少；不够时返回已成交数量
function walk(book, qty, isBuy) {
  let left = qty, total = 0;
  for (const [price, vol, min] of book) {
    if (left <= 0) break;
    if (isBuy && min > left) continue;   // 收单有最小数量
    const n = Math.min(left, vol);
    total += n * price;
    left -= n;
  }
  return { total, filled: qty - left };
}

async function appraise() {
  const text = $('apInput').value;
  const out = $('apResult');
  if (!text.trim()) { out.innerHTML = '<div class="ap-empty">先在左边粘贴物品列表</div>'; return; }
  out.innerHTML = '<div class="ap-empty" id="apProgress">载入物品名称…</div>';
  try { await loadNames(); } catch (e) { out.innerHTML = `<div class="ap-empty">物品名称载入失败：${ctx.esc(e.message)}</div>`; return; }
  const { items, unknown } = parse(text);
  if (!items.size) { out.innerHTML = `<div class="ap-empty">没有识别出物品${unknown.length ? '：' + ctx.esc(unknown.slice(0, 3).join('、')) : ''}</div>`; return; }
  const region = ctx.regions.find((r) => r.id === A.hub) || ctx.regions[0];
  const ids = [...items.keys()];
  const [avg] = await Promise.all([
    ctx.getMarketPriceMap().catch(() => new Map()),
    hubOrders(region, ids, (d, t) => { const el = $('apProgress'); if (el) el.textContent = `读取${region.hub.name}挂单 ${d}/${t}`; })
  ]);
  const rows = ids.map((id) => {
    const qty = items.get(id);
    const o = A.orders.get(region.id + ':' + id) || {};
    const depthSell = o.buys ? walk(o.buys, qty, true) : { total: 0, filled: 0 };
    const depthBuy = o.sells ? walk(o.sells, qty, false) : { total: 0, filled: 0 };
    return {
      id, qty, name: A.names.byId[id] || 'Type ' + id, failed: o.failed,
      sell: o.sell ?? null, buy: o.buy ?? null, avg: avg.get(id) || null,
      depthSell, depthBuy
    };
  });
  const sum = (f) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  A.result = {
    region, rows, unknown,
    sellTotal: sum((r) => r.sell != null && r.qty * r.sell),
    buyTotal: sum((r) => r.buy != null && r.qty * r.buy),
    avgTotal: sum((r) => r.avg != null && r.qty * r.avg),
    depthSellTotal: sum((r) => r.depthSell.total),
    shortBuy: rows.filter((r) => r.buy != null && r.depthSell.filled < r.qty),
    noSell: rows.filter((r) => r.sell == null), noBuy: rows.filter((r) => r.buy == null)
  };
  render();
}

function render() {
  const R = A.result;
  const isk = (v) => (v == null ? '—' : ctx.formatISK(v));
  const sortKey = A.sort || 'sell';
  const rows = R.rows.slice().sort((a, b) => ((b.qty * (b[sortKey] ?? 0)) - (a.qty * (a[sortKey] ?? 0))));
  const body = rows.map((r) => {
    const short = r.buy != null && r.depthSell.filled < r.qty;
    return `<tr>
      <td><div class="ap-item"><img src="${ICON(r.id)}" alt="" width="28" height="28" loading="lazy"><span><a href="#type=${r.id}" title="查看市场">${ctx.esc(r.name)}</a><small class="ap-unit">单价 卖 ${isk(r.sell)} · 收 ${isk(r.buy)}</small></span></div></td>
      <td class="num">${ctx.formatNumber(r.qty)}</td>
      <td class="num ap-sell ap-hide-sm">${isk(r.sell)}</td>
      <td class="num ap-buy ap-hide-sm">${isk(r.buy)}</td>
      <td class="num ap-sell ap-strong">${r.sell == null ? '—' : ctx.formatISK(r.qty * r.sell)}</td>
      <td class="num ap-buy ap-strong">${r.buy == null ? '—' : ctx.formatISK(r.qty * r.buy)}${short ? `<small title="收单总量不够">收单只够 ${ctx.formatNumber(r.depthSell.filled)}</small>` : ''}</td>
      <td class="num ap-hide-sm">${r.avg == null ? '—' : ctx.formatISK(r.qty * r.avg)}</td>
    </tr>`;
  }).join('');
  const notes = [];
  if (R.shortBuy.length) notes.push(`${R.shortBuy.length} 种物品的收单量不够，按挂单深度一次性全部卖给收单约 <b>${ctx.formatISK(R.depthSellTotal)}</b>`);
  if (R.noSell.length) notes.push(`${R.noSell.length} 种在${ctx.esc(R.region.hub.name)}没有卖单：${R.noSell.slice(0, 6).map((r) => ctx.esc(r.name)).join('、')}${R.noSell.length > 6 ? ' 等' : ''}`);
  if (R.noBuy.length) notes.push(`${R.noBuy.length} 种没有收单`);
  if (R.unknown.length) notes.push(`<span class="ap-warn">${R.unknown.length} 行没认出来：${R.unknown.slice(0, 5).map((l) => ctx.esc(l.slice(0, 30))).join('、')}${R.unknown.length > 5 ? ' 等' : ''}</span>`);
  $('apResult').innerHTML = `
    <div class="ap-stats">
      <div class="ap-stat-sell"><span>按最低卖价</span><b>${ctx.formatISK(R.sellTotal)}</b><small>挂单卖出 / 直接买入的价格</small></div>
      <div class="ap-stat-buy"><span>按最高收价</span><b>${ctx.formatISK(R.buyTotal)}</b><small>直接卖给收单的价格</small></div>
      <div><span>全服均价</span><b>${ctx.formatISK(R.avgTotal)}</b><small>${R.rows.length} 种 · ${ctx.formatNumber(R.rows.reduce((t, r) => t + r.qty, 0))} 件</small></div>
    </div>
    ${notes.length ? `<ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr>
        <th>物品</th><th class="num">数量</th><th class="num ap-hide-sm">最低卖价</th><th class="num ap-hide-sm">最高收价</th>
        <th class="num"><button type="button" data-ap-sort="sell" class="${sortKey === 'sell' ? 'active' : ''}">卖单小计</button></th>
        <th class="num"><button type="button" data-ap-sort="buy" class="${sortKey === 'buy' ? 'active' : ''}">收单小计</button></th>
        <th class="num ap-hide-sm"><button type="button" data-ap-sort="avg" class="${sortKey === 'avg' ? 'active' : ''}">均价小计</button></th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>合计</td><td></td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="num ap-sell ap-strong">${ctx.formatISK(R.sellTotal)}</td><td class="num ap-buy ap-strong">${ctx.formatISK(R.buyTotal)}</td><td class="num ap-hide-sm">${ctx.formatISK(R.avgTotal)}</td></tr></tfoot>
    </table></div>
    <div class="ap-foot">
      <span class="text-muted">${ctx.esc(R.region.hub.name)}挂单 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}${SERVER.id === 'tq' ? '' : ' · ' + SERVER.full}</span>
      <button type="button" class="btn btn-ghost" data-ap-copy>复制结果</button>
    </div>`;
}

function resultText() {
  const R = A.result;
  const isk = (v) => (v == null ? '—' : Math.round(v).toLocaleString('zh-CN'));
  return [
    `合同估价（${R.region.hub.name}）`,
    ...R.rows.map((r) => `${r.name} ×${r.qty}　卖 ${isk(r.sell == null ? null : r.sell * r.qty)}　收 ${isk(r.buy == null ? null : r.buy * r.qty)}`),
    `合计：按最低卖价 ${isk(R.sellTotal)} ISK，按最高收价 ${isk(R.buyTotal)} ISK`
  ].join('\n');
}

export function showAppraisal() {
  const main = $('apMain');
  if (main.dataset.ready) return;
  main.dataset.ready = '1';
  main.innerHTML = `
    <section class="ap-page">
      <div class="ap-head"><h2>合同估价</h2><span class="text-muted">游戏里打开合同 → 全选物品 → Ctrl+C，粘贴到下面</span></div>
      <div class="ap-layout">
        <div class="ap-form">
          <textarea id="apInput" class="ap-input" spellcheck="false" placeholder="例如：&#10;小型掠能器 II*	1	掠能器*	装备*	高能量槽&#10;液化臭氧*	150	冰矿产物*	材料*	货柜舱&#10;掘金者级*	1	勘探护卫舰*	舰船*&#10;&#10;也可以：名称 x 数量，或一行一个名称"></textarea>
          <div class="ap-controls">
            <label class="select-wrap" title="交易中心">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <select id="apHub" class="region-select" aria-label="交易中心">${ctx.regions.map((r) => `<option value="${r.id}"${r.id === A.hub ? ' selected' : ''}>${ctx.esc(r.hub.name)}</option>`).join('')}</select>
            </label>
            <button type="button" class="btn btn-ghost" id="apClear">清空</button>
            <button type="button" class="btn btn-primary" id="apGo">估价</button>
          </div>
        </div>
        <div class="ap-result" id="apResult"><div class="ap-empty">粘贴后点「估价」（Ctrl+Enter）</div></div>
      </div>
    </section>`;
  $('apGo').addEventListener('click', appraise);
  $('apClear').addEventListener('click', () => { $('apInput').value = ''; $('apInput').focus(); });
  $('apInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); appraise(); } });
  // 直接粘贴时自动估价
  $('apInput').addEventListener('paste', () => setTimeout(appraise, 0));
  $('apHub').addEventListener('change', (e) => {
    A.hub = Number(e.target.value);
    ctx.store.setJSON(STORE_KEY, { hub: A.hub });
    if (A.result) appraise();
  });
  $('apResult').addEventListener('click', (e) => {
    const s = e.target.closest('[data-ap-sort]');
    if (s) { A.sort = s.dataset.apSort; render(); return; }
    if (e.target.closest('[data-ap-copy]')) ctx.copyText(resultText(), '已复制估价结果');
  });
  loadNames().catch(() => {});
}
