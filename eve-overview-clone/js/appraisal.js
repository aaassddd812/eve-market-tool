// ===== 估价 =====
// 粘贴游戏里复制的合同物品列表（或仓库、装配、货柜清单），按交易中心挂单估价：
// 每件物品的最低卖价、最高收价，合计「按卖单」「按收单」两种总价；收单量不够时另算按挂单深度能卖出的价值。
// 技能与交易税费用全站共用的 trade-fees.js（市场详情、资产估值同一套设置）：卖给收单只交销售税，挂卖单另交中介费。
// 化矿估价：按 reprocess-data.json（build_reprocess.mjs 从 SDE 生成）算再处理产出，技能可自定义或读取已绑定角色。
//   矿石 / 冰矿 / 卫星矿：(50 + 改装件) × (1 + 安全等级) × (1 + 建筑加成) × (1 + 提炼学概论 3%) × (1 + 提炼效率理论 2%) × (1 + 对应矿石处理 2%) × (1 + 植入体)
//   NPC 空间站基础 50%，不吃改装件 / 建筑 / 安全等级加成；其它物品按碎铁处理：50% × (1 + 碎铁处理技术 2%)。
// 识别格式：制表符或两个以上空格分列，第一列物品名（游戏复制的名称后可能带 *），第二列数量；
// 也支持「名称 x 数量」「数量 x 名称」「名称 数量」和单独一行物品名。
import { SERVER } from './server.js?v=s3';
import * as TF from './trade-fees.js?v=v3';

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, fetchESIPaged, getMarketPriceMap, getTypeIndex() -> Map(id -> { type }), valuation,
          // hasEsiToken, getCharacterSkills, getCharacterImplants, openEsiBind, loadAbyssal() -> abyssal.js 模块
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-appraisal-v1';
const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

const A = { names: null, loading: null, orders: new Map(), result: null, hub: SERVER.regions[0].id, view: 'market', rp: null, rpLoading: null, char: null };

// 化矿设置：station npc / athanor / tatara；rig 0 / 1(T1) / 3(T2)；sec h / l / n（高安 / 低安 / 00 与虫洞）；imp 植入体加成 %；tax 再处理税 %
const S = { station: 'npc', rig: 0, sec: 'h', imp: 0, tax: 0 };
const SKILL = { reproc: 3385, eff: 3389, scrap: 12196 };
const level = TF.level, fees = TF.fees, pct2 = TF.pct2;
const SEC = { h: 0, l: 0.06, n: 0.12 };
const STRUCT = { athanor: 0.02, tatara: 0.055 };
const IMPLANTS = { 27175: 1, 27169: 2, 27174: 4 };   // 载诺 守财奴 提炼 RX-801 / 802 / 804

export function initAppraisal(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {});
  A.hub = ctx.valuation.region().id;   // 交易中心与全站估值共用同一个选择
  if (saved.view === 'reproc') A.view = 'reproc';
  if (saved.rp && typeof saved.rp === 'object') {
    const r = saved.rp;
    if (['npc', 'athanor', 'tatara'].includes(r.station)) S.station = r.station;
    if ([0, 1, 3].includes(r.rig)) S.rig = r.rig;
    if (r.sec in SEC) S.sec = r.sec;
    if ([0, 1, 2, 4].includes(r.imp)) S.imp = r.imp;
    if (Number.isFinite(r.tax)) S.tax = Math.min(100, Math.max(0, r.tax));
    // 旧版把技能与税费存在估价页里，迁移到共用设置
    if (!TF.hasSaved() && (r.src || r.lv || r.market)) TF.update({ src: r.src, all: r.all, lv: r.lv || {}, market: r.market, fac: r.fac, corp: r.corp, broker: r.broker });
  }
}

function save() {
  ctx.store.setJSON(STORE_KEY, { hub: A.hub, view: A.view, rp: S });
}

function loadReprocess() {
  if (!A.rpLoading) {
    A.rpLoading = fetch('reprocess-data.json?v=1')
      .then((r) => { if (!r.ok) throw new Error('reprocess-data.json ' + r.status); return r.json(); })
      .then((d) => { A.rp = d; return d; })
      .catch((e) => { A.rpLoading = null; throw e; });
  }
  return A.rpLoading;
}

// 化矿率：skill 为物品的专属处理技能（0 = 碎铁处理）
function yieldFor(skill) {
  if (!skill) return 0.5 * (1 + 0.02 * level(SKILL.scrap));
  const base = S.station === 'npc' ? 50 : (50 + S.rig) * (1 + SEC[S.sec]) * (1 + STRUCT[S.station]);
  return base / 100 * (1 + 0.03 * level(SKILL.reproc)) * (1 + 0.02 * level(SKILL.eff)) * (1 + 0.02 * level(skill)) * (1 + S.imp / 100);
}
const pct = (v) => (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
const rangePct = (a, b) => (pct(a) === pct(b) ? pct(a) : `${pct(a).slice(0, -1)}–${pct(b)}`);

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

// 伊甸币（PLEX）是全服统一市场，订单都在星域 19000001，不分交易中心（与 modern-app.js 一致）
const GLOBAL_MARKET_REGION = 19000001;
const GLOBAL_MARKET_TYPES = new Set([44992]);

// 交易中心挂单：最低卖价、最高收价，以及按价格排好的收单（算深度用）
// 全宇宙：只有最低卖 / 最高收（击杀记录服务汇总），没有挂单深度
async function hubOrders(region, ids, onProgress) {
  if (region.all) {
    const v = await ctx.valuation.items(ids.map((id) => ({ type_id: id, quantity: 1 })), onProgress);
    for (const id of ids) { const p = v.price(id); A.orders.set(region.id + ':' + id, p.failed ? { failed: true } : { sell: p.sell ?? null, buy: p.buy ?? null }); }
    return;
  }
  const todo = ids.filter((id) => !A.orders.has(region.id + ':' + id));
  let done = ids.length - todo.length;
  onProgress(done, ids.length);
  const queue = todo.slice();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      let entry;
      try {
        const global = GLOBAL_MARKET_TYPES.has(Number(id));
        const orders = (await ctx.fetchESIPaged(`/markets/${global ? GLOBAL_MARKET_REGION : region.id}/orders/?order_type=all&type_id=${id}`)).filter((o) => global || o.location_id === region.hub.id);
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
  // 深渊装备：游戏里拖进聊天框的物品链接带有单件 item_id（showinfo:类型//物品），单独按 MutaMarket 模型估价
  const hasLinks = /showinfo:\d+\/\/\d+/.test(text);
  mountAbyssal(hasLinks ? text : '');
  const plain = hasLinks ? text.split('\n').filter((l) => !/showinfo:\d+\/\/\d+/.test(l)).join('\n') : text;
  if (!plain.trim()) { A.result = null; out.innerHTML = ''; return; }
  out.innerHTML = '<div class="ap-empty" id="apProgress">载入物品名称…</div>';
  try { await loadNames(); } catch (e) { out.innerHTML = `<div class="ap-empty">物品名称载入失败：${ctx.esc(e.message)}</div>`; return; }
  const { items, unknown } = parse(plain);
  if (!items.size) { A.result = null; out.innerHTML = `<div class="ap-empty">没有识别出物品${unknown.length ? '：' + ctx.esc(unknown.slice(0, 3).join('、')) : ''}</div>`; return; }
  const region = ctx.valuation.sources.find((r) => r.id === A.hub) || ctx.valuation.sources[0];
  const ids = [...items.keys()];
  // 化矿产物也要挂单价；化矿数据载入失败时只做市场估价
  const rp = await loadReprocess().catch((e) => { console.warn('化矿数据载入失败', e); return null; });
  const mats = new Set();
  if (rp) for (const id of ids) { const m = rp.t[id]?.[2] || []; for (let i = 0; i < m.length; i += 2) mats.add(m[i]); }
  const all = [...new Set([...ids, ...mats])];
  const [avg] = await Promise.all([
    ctx.getMarketPriceMap().catch(() => new Map()),
    hubOrders(region, all, (d, t) => { const el = $('apProgress'); if (el) el.textContent = `读取${region.hub.name}挂单 ${d}/${t}`; })
  ]);
  const rows = ids.map((id) => {
    const qty = items.get(id);
    const o = A.orders.get(region.id + ':' + id) || {};
    // 全宇宙没有挂单深度：按最高收价全部成交计
    const depthSell = o.buys ? walk(o.buys, qty, true) : region.all && o.buy != null ? { total: o.buy * qty, filled: qty } : { total: 0, filled: 0 };
    const depthBuy = o.sells ? walk(o.sells, qty, false) : { total: 0, filled: 0 };
    return {
      id, qty, name: nameOf(id), failed: o.failed,
      sell: o.sell ?? null, buy: o.buy ?? null, avg: avg.get(id) || null,
      depthSell, depthBuy
    };
  });
  const sum = (f) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  A.result = {
    region, rows, unknown, at: new Date(), hasRp: Boolean(rp),
    sellTotal: sum((r) => r.sell != null && r.qty * r.sell),
    buyTotal: sum((r) => r.buy != null && r.qty * r.buy),
    avgTotal: sum((r) => r.avg != null && r.qty * r.avg),
    depthSellTotal: sum((r) => r.depthSell.total),
    shortBuy: rows.filter((r) => r.buy != null && r.depthSell.filled < r.qty),
    noSell: rows.filter((r) => r.sell == null), noBuy: rows.filter((r) => r.buy == null)
  };
  render();
}

// 深渊装备卡片在 #apAby（render() 只重绘 #apResult，不影响它）
async function mountAbyssal(text) {
  const el = $('apAby');
  const seq = (A.abySeq = (A.abySeq || 0) + 1);
  if (!text) { el.innerHTML = ''; return; }
  try {
    const m = await ctx.loadAbyssal();
    if (seq === A.abySeq) m.mountList(el, m.parseLinks(text));
  } catch (e) {
    if (seq === A.abySeq) el.innerHTML = `<div class="ap-empty">深渊估价加载失败：${ctx.esc(e.message)}</div>`;
  }
}

const nameOf = (id) => A.names.byId[id] || 'Type ' + id;
const price = (id) => A.orders.get(A.result.region.id + ':' + id) || {};

// 化矿：按当前设置算每件物品的产出与价值（价格已在 appraise 里取好，改设置不用重新读挂单）
function reprocess() {
  const R = A.result;
  const rows = [], skip = [], outputs = new Map();
  const keep = 1 - S.tax / 100;
  for (const r of R.rows) {
    const d = A.rp?.t[r.id];
    if (!d) { skip.push(r); continue; }
    const [portion, skill, m] = d;
    const batches = Math.floor(r.qty / portion);
    const y = yieldFor(skill);
    let buy = 0, sell = 0, missing = 0;
    const out = [];
    for (let i = 0; i < m.length; i += 2) {
      const n = Math.floor(batches * m[i + 1] * y);
      if (!n) continue;
      const p = price(m[i]);
      out.push([m[i], n]);
      outputs.set(m[i], (outputs.get(m[i]) || 0) + n);
      if (p.buy != null) buy += n * p.buy; else missing++;
      if (p.sell != null) sell += n * p.sell;
    }
    const used = batches * portion;
    rows.push({
      ...r, skill, y, portion, batches, left: r.qty - used, out, missing,
      rpBuy: buy * keep, rpSell: sell * keep,
      direct: r.buy == null ? null : used * r.buy
    });
  }
  const mats = [...outputs].map(([id, qty]) => {
    const p = price(id);
    return { id, qty, name: nameOf(id), buy: p.buy ?? null, sell: p.sell ?? null };
  }).sort((a, b) => b.qty * (b.buy ?? 0) - a.qty * (a.buy ?? 0));
  const sum = (list, f) => list.reduce((t, x) => t + (f(x) || 0), 0);
  const ores = rows.filter((r) => r.skill).map((r) => r.y);
  return {
    rows, skip, mats,
    buyTotal: sum(rows, (r) => r.rpBuy), sellTotal: sum(rows, (r) => r.rpSell),
    directTotal: sum(rows, (r) => r.direct),
    taxTotal: S.tax ? sum(mats, (m) => m.buy != null && m.qty * m.buy) * S.tax / 100 : 0,
    leftover: rows.filter((r) => r.left > 0),
    oreYield: ores.length ? rangePct(Math.min(...ores), Math.max(...ores)) : null
  };
}

function render() {
  const R = A.result;
  const rp = R.hasRp ? reprocess() : null;
  A.rpResult = rp;
  const tabs = `<div class="segmented ap-tabs" role="tablist">
      <button type="button" role="tab" data-ap-view="market" class="${A.view === 'market' ? 'active' : ''}">市场估价</button>
      <button type="button" role="tab" data-ap-view="reproc" class="${A.view === 'reproc' ? 'active' : ''}"${rp ? '' : ' disabled title="化矿数据载入失败"'}>化矿估价</button>
    </div>`;
  const foot = `<div class="ap-foot">
      <span class="text-muted">${ctx.esc(R.region.hub.name)}挂单 · ${R.at.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}${SERVER.id === 'tq' ? '' : ' · ' + SERVER.full}</span>
      <button type="button" class="btn btn-ghost" data-ap-copy>复制结果</button>
    </div>`;
  $('apResult').innerHTML = tabs + (A.view === 'reproc' && rp ? reprocHtml(R, rp) : marketHtml(R, rp)) + foot;
  // 技能列表跟着物品变（只列用到的矿石处理技能）
  renderPanels();
}

function marketHtml(R, rp) {
  const isk = (v) => (v == null ? '—' : ctx.formatISK(v));
  const f = fees();
  const sellNet = R.sellTotal * (1 - f.sales - f.broker), buyNet = R.buyTotal * (1 - f.sales);
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
  return `
    <div class="ap-stats">
      <div class="ap-stat-sell"><span>按最低卖价</span><b>${ctx.formatISK(R.sellTotal)}</b><small>挂卖单税后 <em>${ctx.formatISK(sellNet)}</em>（−${pct2(f.sales + f.broker)}）</small></div>
      <div class="ap-stat-buy"><span>按最高收价</span><b>${ctx.formatISK(R.buyTotal)}</b><small>卖给收单税后 <em>${ctx.formatISK(buyNet)}</em>（−${pct2(f.sales)}）</small></div>
      <div><span>全服均价</span><b>${ctx.formatISK(R.avgTotal)}</b><small>${R.rows.length} 种 · ${ctx.formatNumber(R.rows.reduce((t, r) => t + r.qty, 0))} 件</small></div>
    </div>
    ${rp && rp.rows.length ? `<button type="button" class="ap-rp-hint" data-ap-view="reproc">化矿后产物按收单约 <b>${ctx.formatISK(rp.buyTotal)}</b>${rp.directTotal ? `，${rp.buyTotal >= rp.directTotal ? '比直接卖收单多' : '比直接卖收单少'} ${pct(Math.abs(rp.buyTotal / rp.directTotal - 1))}` : ''} →</button>` : ''}
    ${notes.length ? `<ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr>
        <th>物品</th><th class="num">数量</th><th class="num ap-hide-sm">最低卖价</th><th class="num ap-hide-sm">最高收价</th>
        <th class="num"><button type="button" data-ap-sort="sell" class="${sortKey === 'sell' ? 'active' : ''}">卖单小计</button></th>
        <th class="num"><button type="button" data-ap-sort="buy" class="${sortKey === 'buy' ? 'active' : ''}">收单小计</button></th>
        <th class="num ap-hide-sm"><button type="button" data-ap-sort="avg" class="${sortKey === 'avg' ? 'active' : ''}">均价小计</button></th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>合计</td><td></td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="num ap-sell ap-strong">${ctx.formatISK(R.sellTotal)}</td><td class="num ap-buy ap-strong">${ctx.formatISK(R.buyTotal)}</td><td class="num ap-hide-sm">${ctx.formatISK(R.avgTotal)}</td></tr>
        <tr class="ap-net"><td>税后</td><td></td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="num ap-sell">${ctx.formatISK(sellNet)}</td><td class="num ap-buy">${ctx.formatISK(buyNet)}</td><td class="ap-hide-sm"></td></tr></tfoot>
    </table></div>`;
}

function reprocHtml(R, rp) {
  const isk = (v) => (v == null ? '—' : ctx.formatISK(v));
  const fmt = ctx.formatNumber;
  const diff = rp.directTotal ? rp.buyTotal / rp.directTotal - 1 : null;
  const f = fees();
  const items = rp.rows.slice().sort((a, b) => b.rpBuy - a.rpBuy).map((r) => {
    const better = r.direct == null ? null : r.rpBuy > r.direct;
    return `<tr>
      <td><div class="ap-item"><img src="${ICON(r.id)}" alt="" width="28" height="28" loading="lazy"><span><a href="#type=${r.id}" title="查看市场">${ctx.esc(r.name)}</a><small class="ap-unit">${pct(r.y)} · ${ctx.esc(A.rp.skills[r.skill || SKILL.scrap] || '')}</small></span></div></td>
      <td class="num">${fmt(r.qty)}${r.left ? `<small title="不足一批（${fmt(r.portion)} 个）的部分不会化掉">剩 ${fmt(r.left)}</small>` : ''}</td>
      <td class="num ap-hide-sm" title="${ctx.esc(A.rp.skills[r.skill || SKILL.scrap] || '')}">${pct(r.y)}</td>
      <td class="num ap-buy ap-strong">${r.batches ? ctx.formatISK(r.rpBuy) : '—'}${r.missing ? `<small>${r.missing} 种产物没有收单</small>` : ''}</td>
      <td class="num ap-hide-sm">${isk(r.direct)}</td>
      <td>${!r.batches ? '<span class="ap-tag">不足一批</span>' : better == null ? '<span class="ap-tag ap-tag-rp">化矿</span>' : better ? `<span class="ap-tag ap-tag-rp">化矿 +${pct(r.direct ? r.rpBuy / r.direct - 1 : 1)}</span>` : `<span class="ap-tag ap-tag-sell">直接卖</span>`}</td>
    </tr>`;
  }).join('');
  const mats = rp.mats.map((m) => `<tr>
      <td><div class="ap-item"><img src="${ICON(m.id)}" alt="" width="28" height="28" loading="lazy"><span><a href="#type=${m.id}" title="查看市场">${ctx.esc(m.name)}</a><small class="ap-unit">收 ${isk(m.buy)} · 卖 ${isk(m.sell)}</small></span></div></td>
      <td class="num">${fmt(m.qty)}</td>
      <td class="num ap-buy ap-hide-sm">${isk(m.buy)}</td>
      <td class="num ap-buy ap-strong">${m.buy == null ? '—' : ctx.formatISK(m.qty * m.buy)}</td>
      <td class="num ap-sell">${m.sell == null ? '—' : ctx.formatISK(m.qty * m.sell)}</td>
    </tr>`).join('');
  const notes = [];
  notes.push(`化矿率：${rp.oreYield != null ? `矿石 / 冰矿 ${rp.oreYield} · ` : ''}碎铁 ${pct(yieldFor(0))}（${S.station === 'npc' ? 'NPC 空间站' : S.station === 'athanor' ? '阿塔诺' : '塔塔拉'}${TF.settings().src === 'char' ? (TF.character() ? ' · ' + ctx.esc(TF.character().name) + ' 的技能' : ' · <span class="ap-warn">角色技能未读取，按 0 级算</span>') : ''}）`);
  if (S.tax) notes.push(`已扣再处理税 ${S.tax}%（约 ${ctx.formatISK(rp.taxTotal)}）`);
  if (rp.leftover.length) notes.push(`${rp.leftover.length} 种物品有不足一批的零头不会化掉：${rp.leftover.slice(0, 4).map((r) => ctx.esc(r.name)).join('、')}${rp.leftover.length > 4 ? ' 等' : ''}`);
  if (rp.skip.length) notes.push(`${rp.skip.length} 种物品不能化矿：${rp.skip.slice(0, 6).map((r) => ctx.esc(r.name)).join('、')}${rp.skip.length > 6 ? ' 等' : ''}`);
  if (R.unknown.length) notes.push(`<span class="ap-warn">${R.unknown.length} 行没认出来</span>`);
  if (!rp.rows.length) return `<ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul><div class="ap-empty">这些物品都不能化矿</div>`;
  return `
    <div class="ap-stats">
      <div class="ap-stat-buy"><span>化矿产物·按收单</span><b>${ctx.formatISK(rp.buyTotal)}</b><small>卖给收单税后 <em>${ctx.formatISK(rp.buyTotal * (1 - f.sales))}</em></small></div>
      <div class="ap-stat-sell"><span>化矿产物·按卖单</span><b>${ctx.formatISK(rp.sellTotal)}</b><small>挂卖单税后 <em>${ctx.formatISK(rp.sellTotal * (1 - f.sales - f.broker))}</em></small></div>
      <div><span>原物品直接卖收单</span><b>${isk(rp.directTotal || null)}</b><small>${rp.directTotal ? `税后 ${ctx.formatISK(rp.directTotal * (1 - f.sales))} · ` : ''}${diff == null ? '原物品没有收单' : diff >= 0 ? `化矿多 <em class="ap-up">${pct(diff)}</em>` : `化矿少 <em class="ap-down">${pct(-diff)}</em>`}</small></div>
    </div>
    <ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr><th>物品</th><th class="num">数量</th><th class="num ap-hide-sm">化矿率</th><th class="num">化矿价值</th><th class="num ap-hide-sm">直接卖收单</th><th>建议</th></tr></thead>
      <tbody>${items}</tbody>
      <tfoot><tr><td>合计</td><td></td><td class="ap-hide-sm"></td><td class="num ap-buy ap-strong">${ctx.formatISK(rp.buyTotal)}</td><td class="num ap-hide-sm">${isk(rp.directTotal || null)}</td><td></td></tr></tfoot>
    </table></div>
    <h3 class="ap-sub">化矿产物</h3>
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr><th>产物</th><th class="num">数量</th><th class="num ap-hide-sm">最高收价</th><th class="num">收单小计</th><th class="num">卖单小计</th></tr></thead>
      <tbody>${mats}</tbody>
      <tfoot><tr><td>合计${S.tax ? '（税前）' : ''}</td><td></td><td class="ap-hide-sm"></td><td class="num ap-buy ap-strong">${ctx.formatISK(rp.mats.reduce((t, m) => t + (m.buy == null ? 0 : m.qty * m.buy), 0))}</td><td class="num ap-sell ap-strong">${ctx.formatISK(rp.mats.reduce((t, m) => t + (m.sell == null ? 0 : m.qty * m.sell), 0))}</td></tr></tfoot>
    </table></div>`;
}

function resultText() {
  const R = A.result;
  const isk = (v) => (v == null ? '—' : Math.round(v).toLocaleString('zh-CN'));
  const rp = A.rpResult;
  const f = fees();
  if (A.view === 'reproc' && rp) {
    return [
      `化矿估价（${R.region.hub.name}，矿石 ${rp.oreYield ?? '—'} · 碎铁 ${pct(yieldFor(0))}${S.tax ? ' · 税 ' + S.tax + '%' : ''}）`,
      ...rp.mats.map((m) => `${m.name} ×${m.qty}　收 ${isk(m.buy == null ? null : m.buy * m.qty)}`),
      `合计：产物按最高收价 ${isk(rp.buyTotal)} ISK，按最低卖价 ${isk(rp.sellTotal)} ISK；原物品直接卖收单 ${isk(rp.directTotal)} ISK`,
      `税后：产物卖给收单 ${isk(rp.buyTotal * (1 - f.sales))} ISK，挂卖单 ${isk(rp.sellTotal * (1 - f.sales - f.broker))} ISK（销售税 ${pct2(f.sales)} · 中介费 ${pct2(f.broker)}）`
    ].join('\n');
  }
  return [
    `估价（${R.region.hub.name}）`,
    ...R.rows.map((r) => `${r.name} ×${r.qty}　卖 ${isk(r.sell == null ? null : r.sell * r.qty)}　收 ${isk(r.buy == null ? null : r.buy * r.qty)}`),
    `合计：按最低卖价 ${isk(R.sellTotal)} ISK，按最高收价 ${isk(R.buyTotal)} ISK`,
    `税后：挂卖单 ${isk(R.sellTotal * (1 - f.sales - f.broker))} ISK，卖给收单 ${isk(R.buyTotal * (1 - f.sales))} ISK（销售税 ${pct2(f.sales)} · 中介费 ${pct2(f.broker)}）`
  ].join('\n');
}

// 设置面板：技能（交易与化矿共用）、交易税费、化矿设置
const BASE_SKILLS = [SKILL.reproc, SKILL.eff, SKILL.scrap];
const segHtml = (name, items, disabled = false) => `<div class="segmented ap-seg" role="group">${items.map(([v, l]) => `<button type="button" data-ap-set="${name}" data-v="${v}" class="${String(S[name]) === String(v) ? 'active' : ''}"${disabled ? ' disabled' : ''}>${l}</button>`).join('')}</div>`;

function skillsHtml() {
  // 化矿技能只列出基础三项与当前物品用到的矿石处理技能（没有估价结果时列出全部）
  const used = new Set(A.result && A.rp ? A.result.rows.map((r) => A.rp.t[r.id]?.[1]).filter(Boolean) : Object.keys(A.rp?.skills || {}).map(Number));
  const oreSkills = Object.keys(A.rp?.skills || {}).map(Number).filter((id) => !BASE_SKILLS.includes(id) && used.has(id));
  const named = (ids) => ids.map((id) => [id, A.rp.skills[id] || '技能 ' + id]);
  return TF.skillFormHtml([['交易', TF.TRADE_SKILLS], ['化矿', A.rp ? named([...BASE_SKILLS, ...oreSkills]) : []]]);
}

function rpHtml() {
  const npc = S.station === 'npc';
  return `
    <div class="ap-rp-row"><span>地点</span>${segHtml('station', [['npc', 'NPC 空间站'], ['athanor', '阿塔诺'], ['tatara', '塔塔拉']])}</div>
    <div class="ap-rp-row"><span>改装件</span>${segHtml('rig', [[0, '无'], [1, 'T1'], [3, 'T2']], npc)}</div>
    <div class="ap-rp-row"><span>安全等级</span>${segHtml('sec', [['h', '高安'], ['l', '低安'], ['n', '00 / 虫洞']], npc)}</div>
    <div class="cr-fields">
      <label><span>植入体</span><select class="cr-input" data-ap-imp aria-label="提炼植入体">${[[0, '无'], [1, 'RX-801 +1%'], [2, 'RX-802 +2%'], [4, 'RX-804 +4%']].map(([v, l]) => `<option value="${v}"${S.imp === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>再处理税 %</span><input class="cr-input" type="number" min="0" max="100" step="0.1" value="${S.tax}" data-ap-tax aria-label="再处理税"></label>
    </div>
    <p class="ap-rp-tip" title="改装件、建筑与安全等级加成只作用于矿石 / 冰矿 / 卫星矿；装备等按碎铁处理技术算">NPC 空间站声望 0 时再处理税约 5%</p>`;
}

function updateSummaries() {
  const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  set('apSkSum', TF.skillSummary());
  set('apFeeSum', TF.summary());
  set('apRpSum', `矿石 ${A.rpResult?.oreYield ?? pct(yieldFor(60377))} · 碎铁 ${pct(yieldFor(0))}`);
}

function renderPanels() {
  const put = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  put('apSkBody', skillsHtml());
  put('apFeeBody', TF.feeFormHtml());
  if (A.rp) put('apRpBody', rpHtml());
  updateSummaries();
}

function renderRp() {
  if (A.result) render(); else renderPanels();
}

// 读到角色技能后，当前植入体里有提炼植入体时自动带上（需要 esi-clones.read_implants.v1，失败就保持手动设置）
let implantsFor = null;
async function syncImplants() {
  const c = TF.character();
  if (!c || implantsFor === c.id) return;
  implantsFor = c.id;
  try {
    const imps = await ctx.getCharacterImplants();
    S.imp = Math.max(0, ...(imps || []).map((id) => IMPLANTS[id] || 0));
    save();
    renderRp();
  } catch { /* 没有植入体权限 */ }
}

export function showAppraisal() {
  const main = $('apMain');
  // 别的页面改了估值来源：跟着切换，已有结果重新估价
  const cur = ctx.valuation.region().id;
  if (main.dataset.ready && cur !== A.hub) {
    A.hub = cur;
    if ($('apHub')) $('apHub').value = String(cur);
    if (A.result) appraise();
  }
  if (main.dataset.ready) return;
  main.dataset.ready = '1';
  main.innerHTML = `
    <section class="ap-page">
      <div class="ap-head"><h2>估价</h2><span class="text-muted">游戏里全选物品 Ctrl+C 后粘贴</span></div>
      <div class="ap-layout">
        <div class="ap-form">
          <textarea id="apInput" class="ap-input" spellcheck="false" placeholder="例如：&#10;小型掠能器 II*	1	掠能器*	装备*	高能量槽&#10;液化臭氧*	150	冰矿产物*	材料*	货柜舱&#10;掘金者级*	1	勘探护卫舰*	舰船*&#10;&#10;也可以：名称 x 数量，或一行一个名称"></textarea>
          <div class="ap-controls">
            <label class="select-wrap" title="交易中心">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <select id="apHub" class="region-select" aria-label="交易中心">${ctx.valuation.sources.map((r) => `<option value="${r.id}"${r.id === A.hub ? ' selected' : ''}>${ctx.esc(r.hub.name)}</option>`).join('')}</select>
            </label>
            <button type="button" class="btn btn-ghost" id="apClear">清空</button>
            <button type="button" class="btn btn-primary" id="apGo">估价</button>
          </div>
          <div class="ap-settings" id="apSettings">
            <details class="ap-rp" id="apSk">
              <summary><span>技能</span><small id="apSkSum"></small></summary>
              <div class="ap-rp-body" id="apSkBody"></div>
            </details>
            <details class="ap-rp" id="apFee">
              <summary><span>交易税费</span><small id="apFeeSum"></small></summary>
              <div class="ap-rp-body" id="apFeeBody"></div>
            </details>
            <details class="ap-rp" id="apRp"${A.view === 'reproc' ? ' open' : ''}>
              <summary><span>化矿设置</span><small id="apRpSum"></small></summary>
              <div class="ap-rp-body" id="apRpBody"><div class="text-muted">载入化矿数据…</div></div>
            </details>
          </div>
        </div>
        <div class="ap-col">
          <div class="ap-result" id="apResult"><div class="ap-empty">粘贴后点「估价」（Ctrl+Enter）</div></div>
          <div id="apAby"></div>
        </div>
      </div>
    </section>`;
  $('apGo').addEventListener('click', appraise);
  $('apClear').addEventListener('click', () => { $('apInput').value = ''; $('apInput').focus(); });
  $('apInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); appraise(); } });
  // 直接粘贴时自动估价
  $('apInput').addEventListener('paste', () => setTimeout(appraise, 0));
  $('apHub').addEventListener('change', (e) => {
    A.hub = Number(e.target.value);
    ctx.valuation.set(A.hub);
    save();
    if (A.result) appraise();
  });
  $('apResult').addEventListener('click', (e) => {
    const s = e.target.closest('[data-ap-sort]');
    if (s) { A.sort = s.dataset.apSort; render(); return; }
    const v = e.target.closest('[data-ap-view]');
    if (v && !v.disabled) {
      A.view = v.dataset.apView;
      save();
      if (A.view === 'reproc') $('apRp').open = true;
      render();
      return;
    }
    if (e.target.closest('[data-ap-copy]')) ctx.copyText(resultText(), '已复制估价结果');
  });
  const settings = $('apSettings');
  settings.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ap-set]');
    if (b && !b.disabled) {
      const k = b.dataset.apSet;
      S[k] = k === 'rig' ? Number(b.dataset.v) : b.dataset.v;
      save();
      renderRp();
    }
  });
  TF.bindForm(settings);
  // 共用设置在任何页面改动后都刷新估价（页面隐藏时也只是重算 HTML）
  TF.onChange(() => { renderRp(); syncImplants(); });
  settings.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-ap-imp]')) S.imp = Number(t.value);
    else if (t.matches('[data-ap-tax]')) S.tax = Math.min(100, Math.max(0, Number(t.value) || 0));
    else return;
    save();
    renderRp();
  });
  renderPanels();
  if (TF.settings().src === 'char') TF.loadCharacter(true).then(syncImplants);
  loadReprocess().then(() => renderRp())
    .catch((e) => { $('apRpBody').innerHTML = `<div class="ap-warn">化矿数据载入失败：${ctx.esc(e.message)}</div>`; });
  loadNames().catch(() => {});
}
