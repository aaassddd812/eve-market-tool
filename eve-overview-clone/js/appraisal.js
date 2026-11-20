// ===== 估价 =====
// 粘贴游戏里复制的合同物品列表（或仓库、装配、货柜清单），按交易中心挂单估价：
// 每件物品的最低卖价、最高收价，合计「按卖单」「按收单」两种总价；收单量不够时另算按挂单深度能卖出的价值。
// 技能与交易税费用全站共用的 trade-fees.js（市场详情、资产估值同一套设置）：卖给收单只交销售税，挂卖单另交中介费。
// 每 m³ 价值：单价 ÷ 包装体积（type-volume.json，与倒卖排行同一份），挖矿、搬运时比较哪种更值钱。
// 化矿估价：按 reprocess-data.json（build_reprocess.mjs 从 SDE 生成）算再处理产出，技能可自定义或读取已绑定角色。
//   公式见 trade-fees.js 的 reprocYield：地点的基础化矿率（按矿石 / 卫星矿 / 冰矿分开）× 技能 × 植入体 × 其它加成；碎铁按地点本身 × 碎铁处理技术。
//   地点三种选法：按类型（NPC 空间站 / 阿塔诺 / 塔塔拉 + 改装件 + 安全等级）、指定建筑（NPC 空间站或玩家建筑）、当前位置（角色停靠的地方）。
//   NPC 空间站的基础化矿率与税读 ESI 空间站资料；玩家建筑的改装件：手动改过的 > 军团资产（总监）> 制造页「我的建筑」，点重新读取时不算手动的。
// 识别格式：制表符或两个以上空格分列，第一列物品名（游戏复制的名称后可能带 *），第二列数量；
// 也支持「名称 x 数量」「数量 x 名称」「名称 数量」和单独一行物品名。
import { SERVER } from './server.js?v=s4';
import * as TF from './trade-fees.js?v=v7';
import * as IS from './ind-structs.js?v=6';

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, fetchESIPaged, getMarketPriceMap, getTypeIndex() -> Map(id -> { type }), valuation, loadVolumes,
          // hasEsiToken, getCharacterSkills, getCharacterImplants, openEsiBind, loadAbyssal() -> abyssal.js 模块,
          // 化矿地点：fetchESI, esiAuthFetch, esiAuthFetchPaged, readToken, hasScope(scope), structureNameMap, saveStructureNames, loadNpcNames, officialName
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'eve-appraisal-v1';
const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;

// ratio：比例 %，算出来的小计、合计、税后都再乘上它（比如收购按 90%），单价保持市场原价
const A = { names: null, loading: null, orders: new Map(), result: null, hub: SERVER.regions[0].id, view: 'market', rp: null, rpLoading: null, char: null, ratio: 100, cmp: [], cmpState: new Map() };

// 化矿设置：mode type 按类型 / pick 指定建筑 / here 当前位置
//   按类型：station npc / athanor / tatara；rig 0 / 1(T1) / 3(T2)；sec h / l / n（高安 / 低安 / 00 与虫洞）
//   loc 指定的建筑、here 当前位置：{ k: 'npc' | 'st', id, key, name, sys, sec, type, eff, take, svc, rigs, rigSrc, fit, base, scrap }（见 locBase）
//   imp 植入体加成 %；tax 再处理税 %；extra 其它加成 %（手动，乘在矿石 / 卫星矿 / 冰矿上）
const S = { mode: 'type', station: 'npc', rig: 0, sec: 'h', imp: 0, tax: 0, extra: 0, loc: null, here: null };
const SKILL = TF.REPROC_SKILL;
const level = TF.level, fees = TF.fees, pct2 = TF.pct2;
const SEC = TF.REPROC_SEC;
const IMPLANTS = { 27175: 1, 27169: 2, 27174: 4 };   // 载诺 守财奴 提炼 RX-801 / 802 / 804

export function initAppraisal(context) {
  ctx = context;
  const saved = ctx.store.getJSON(STORE_KEY, {});
  A.hub = ctx.valuation.region().id;   // 交易中心与全站估值共用同一个选择
  if (saved.view === 'reproc') A.view = 'reproc';
  if (Number.isFinite(saved.ratio) && saved.ratio > 0) A.ratio = saved.ratio;
  if (Array.isArray(saved.cmp)) A.cmp = saved.cmp.filter((c) => c && (c.k === 'hub' || (c.k === 'st' && c.id > 0)) && Number.isFinite(Number(c.id))).slice(0, 8);
  if (saved.rp && typeof saved.rp === 'object') {
    const r = saved.rp;
    if (['npc', 'athanor', 'tatara'].includes(r.station)) S.station = r.station;
    if ([0, 1, 3].includes(r.rig)) S.rig = r.rig;
    if (r.sec in SEC) S.sec = r.sec;
    if ([0, 1, 2, 4].includes(r.imp)) S.imp = r.imp;
    if (Number.isFinite(r.tax)) S.tax = Math.min(100, Math.max(0, r.tax));
    if (['type', 'pick', 'here'].includes(r.mode)) S.mode = r.mode;
    if (Number.isFinite(r.extra)) S.extra = Math.min(100, Math.max(-50, r.extra));
    for (const k of ['loc', 'here']) if (validLoc(r[k])) S[k] = r[k];
    // 旧版把技能与税费存在估价页里，迁移到共用设置
    if (!TF.hasSaved() && (r.src || r.lv || r.market)) TF.update({ src: r.src, all: r.all, lv: r.lv || {}, market: r.market, fac: r.fac, corp: r.corp, broker: r.broker });
  }
}

function save() {
  ctx.store.setJSON(STORE_KEY, { hub: A.hub, view: A.view, rp: S, ratio: A.ratio, cmp: A.cmp });
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
const yieldFor = (skill) => TF.reprocYield(skill, S);
// 可点击复制的价格：复制不带分隔符的数字，方便粘贴到游戏里
const cpNum = (v) => String(Math.round(v * 100) / 100);
// cp / cpCard / fmtK 是金额（小计、合计）：乘上比例；cpu 是单价：保持原价
const K = () => A.ratio / 100;
const cpu = (v) => (v == null ? '—' : `<span class="ap-cp" data-ap-cp="${cpNum(v)}" title="点击复制">${ctx.formatISK(v)}</span>`);
const cp = (v) => cpu(v == null ? null : v * K());
const cpCard = (v) => (v == null ? '' : ` data-ap-cp="${cpNum(v * K())}" title="点击复制"`);
const fmtK = (v) => ctx.formatISK(v * K());
// 每 m³ 价值（单价 ÷ 包装体积，不乘比例）与体积显示
const perM3 = (unit, r) => (unit == null || !r.vol ? null : unit / r.vol);
const fmtM3 = (v) => `${ctx.formatNumber(v >= 100 ? Math.round(v) : Math.round(v * 100) / 100)} m³`;
const ratioNote = () => (A.ratio === 100 ? null : `<span class="ap-warn">小计、合计、税后都已乘以比例 ${A.ratio}%（单价为市场原价）</span>`);
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
  const [avg, , medV, vols] = await Promise.all([
    ctx.getMarketPriceMap().catch(() => new Map()),
    hubOrders(region, all, (d, t) => { const el = $('apProgress'); if (el) el.textContent = `读取${region.hub.name}挂单 ${d}/${t}`; }),
    // 成交中位价（与倒卖排行同一数据，宁静服才有）：一次请求带回 1 / 7 / 14 / 30 天，切天数不用重查
    ctx.valuation.hasMed() ? ctx.valuation.items(ids.map((id) => ({ type_id: id, quantity: 1 }))).catch(() => null) : null,
    ctx.loadVolumes().catch(() => ({}))
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
      med: medV ? medV.price(id).med || null : null,
      vol: vols?.[id] || null,
      depthSell, depthBuy
    };
  });
  const sum = (f) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  A.result = {
    region, rows, unknown, at: new Date(), hasRp: Boolean(rp), hasMed: Boolean(medV),
    sellTotal: sum((r) => r.sell != null && r.qty * r.sell),
    buyTotal: sum((r) => r.buy != null && r.qty * r.buy),
    avgTotal: sum((r) => r.avg != null && r.qty * r.avg),
    depthSellTotal: sum((r) => r.depthSell.total),
    // 总体积与按收单的每 m³ 价值（只算有体积的物品）
    volTotal: sum((r) => r.vol && r.qty * r.vol),
    volBuy: sum((r) => r.vol && r.buy != null && r.qty * r.buy),
    shortBuy: rows.filter((r) => r.buy != null && r.depthSell.filled < r.qty),
    noSell: rows.filter((r) => r.sell == null), noBuy: rows.filter((r) => r.buy == null)
  };
  render();
  loadCompare();
}

// ---------- 多地点比价：在主交易中心之外叠加其它交易中心 / 玩家建筑（可多选），每个地点的卖单 / 收单价都显示 ----------
// A.cmp：[{ k: 'hub', id: 星域 id } | { k: 'st', id: 建筑 id, name }]，存在估价设置里；
// 价格缓存在 A.orders（交易中心 key = 星域 id，建筑 key = 'st' + 建筑 id），玩家建筑整座读一次（ESI 建筑市场权限，modern-app 缓存 5 分钟）
const cmpKey = (c) => (c.k === 'st' ? 'st' + c.id : String(c.id));
const cmpSource = (c) => (c.k === 'hub' ? ctx.valuation.sources.find((r) => r.id === c.id) : null);
function cmpName(c) {
  if (c.k === 'hub') return cmpSource(c)?.hub.name || '交易中心 ' + c.id;
  return ctx.structs?.readable().find((s) => s.id === c.id)?.name || c.name || '建筑 ' + c.id;
}
async function loadCompare() {
  const R = A.result;
  if (!R || !A.cmp.length) return;
  const ids = R.rows.map((r) => r.id);
  await Promise.all(A.cmp.map(async (c) => {
    const key = cmpKey(c);
    if (c.k === 'hub' && key === String(R.region.id)) return;
    if (ids.every((id) => A.orders.has(key + ':' + id))) { A.cmpState.delete(key); return; }
    A.cmpState.set(key, { loading: true });
    try {
      if (c.k === 'hub') {
        const region = cmpSource(c);
        if (!region) throw new Error('没有这个交易中心');
        await hubOrders(region, ids, () => {});
      } else {
        if (!ctx.structs) throw new Error('不支持');
        const m = await ctx.structs.market(c.id);
        if (!m?.byType) throw new Error(m?.denied ? '没有权限读这个建筑的市场' : m?.tooBig ? '订单太多读不了' : '读取失败');
        for (const id of ids) {
          const orders = m.byType.get(id) || [];
          const sells = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
          const buys = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
          A.orders.set(key + ':' + id, { sell: sells[0]?.price ?? null, buy: buys[0]?.price ?? null, buys: buys.map((o) => [o.price, o.volume_remain, o.min_volume || 1]), sells: sells.map((o) => [o.price, o.volume_remain]) });
        }
      }
      A.cmpState.delete(key);
    } catch (e) {
      A.cmpState.set(key, { error: e.message || String(e) });
    }
    if (A.result === R) render();
  }));
  if (A.result === R) render();
}
// 每个比价地点的合计（不含和主交易中心相同的）
function cmpTotals(R) {
  return A.cmp.filter((c) => !(c.k === 'hub' && c.id === R.region.id)).map((c) => {
    const key = cmpKey(c), st = A.cmpState.get(key) || {};
    const ready = !st.loading && !st.error && R.rows.every((r) => A.orders.has(key + ':' + r.id));
    const get = (id) => (ready ? A.orders.get(key + ':' + id) || {} : {});
    let sell = 0, buy = 0, nSell = 0, nBuy = 0;
    for (const r of R.rows) {
      const o = get(r.id);
      if (o.sell != null) { sell += o.sell * r.qty; nSell += 1; }
      if (o.buy != null) { buy += o.buy * r.qty; nBuy += 1; }
    }
    return { c, key, name: cmpName(c), st, ready, get, sell, buy, nSell, nBuy };
  });
}
function cmpHtml(R, T) {
  const chips = A.cmp.map((c, i) => `<span class="ap-cmp-chip${c.k === 'st' ? ' is-st' : ''}">${c.k === 'st' ? '<i title="玩家建筑"></i>' : ''}${ctx.esc(cmpName(c))}<button type="button" data-ap-cmp-del="${i}" title="移除" aria-label="移除">×</button></span>`).join('');
  const head = `<div class="ap-cmp-head"><b>多地点比价</b>${chips}<button type="button" class="btn btn-ghost btn-sm" data-ap-cmp-add>＋ 添加地点</button>
    ${A.cmp.length ? '' : '<span class="text-muted">叠加其它交易中心或玩家建筑，每个地点的卖单 / 收单价一起列出来</span>'}</div>`;
  if (!T.length) return `<div class="ap-cmp">${head}</div>`;
  const all = [{ name: R.region.hub.name, main: true, ready: true, sell: R.sellTotal, buy: R.buyTotal, nSell: R.rows.length - R.noSell.length, nBuy: R.rows.length - R.noBuy.length }, ...T];
  const ok = all.filter((x) => x.ready);
  const n = R.rows.length;
  // 只在物品都有挂单的地点之间比（缺物品的合计偏小，不能当最便宜）
  const bestSell = Math.min(...ok.filter((x) => x.nSell === n).map((x) => x.sell)), bestBuy = Math.max(...ok.filter((x) => x.nBuy === n).map((x) => x.buy));
  const row = (x) => `<tr${x.main ? ' class="is-main"' : ''}><td>${ctx.esc(x.name)}${x.main ? '<small>主</small>' : ''}</td>${!x.ready
    ? `<td colspan="4" class="${x.st?.error ? 'ap-warn' : 'text-muted'}">${x.st?.error ? ctx.esc(x.st.error) : '读取中…'}</td>`
    : `<td class="num ap-sell${x.nSell && x.sell === bestSell ? ' is-best' : ''}">${cp(x.nSell ? x.sell : null)}</td><td class="num ap-muted">${x.nSell}/${n}</td>
       <td class="num ap-buy${x.nBuy && x.buy === bestBuy ? ' is-best' : ''}">${cp(x.nBuy ? x.buy : null)}</td><td class="num ap-muted">${x.nBuy}/${n}</td>`}</tr>`;
  return `<div class="ap-cmp">${head}
    <div class="ap-table-wrap"><table class="ap-table ap-cmp-table"><thead><tr><th>地点</th><th class="num">按最低卖价</th><th class="num">有卖单</th><th class="num">按最高收价</th><th class="num">有收单</th></tr></thead>
    <tbody>${all.map(row).join('')}</tbody></table></div>
    <p class="ap-muted ap-cmp-note">蓝底：买入最便宜（卖价合计最低）/ 卖出最划算（收价合计最高）的地点，只在物品都有挂单的地点之间比；下面每个物品比主交易中心更好的价格加粗</p></div>`;
}
// 添加地点：交易中心 + 能读市场的玩家建筑，可搜索；玩家建筑的发现 / 按名称搜索添加在「我的建筑市场」里
function cmpPopHtml(q = '') {
  const have = new Set(A.cmp.map(cmpKey));
  const lq = q.trim().toLowerCase();
  const hubs = ctx.valuation.sources.filter((r) => r.id !== A.hub && !have.has(String(r.id)) && (!lq || r.hub.name.toLowerCase().includes(lq)));
  const sts = (ctx.structs?.readable() || []).filter((s) => !have.has('st' + s.id) && (!lq || s.name.toLowerCase().includes(lq)));
  const scope = ctx.structs?.hasScope();
  return `<input type="search" class="cr-input" data-ap-cmp-q placeholder="搜索交易中心 / 玩家建筑" value="${ctx.esc(q)}" autocomplete="off">
    <div class="ap-cmp-list">
      ${hubs.length ? `<div class="ap-cmp-group">交易中心</div>${hubs.map((r) => `<button type="button" data-ap-cmp-pick="hub:${r.id}">${ctx.esc(r.hub.name)}</button>`).join('')}` : ''}
      ${sts.length ? `<div class="ap-cmp-group">玩家建筑</div>${sts.map((s) => `<button type="button" data-ap-cmp-pick="st:${s.id}" data-name="${ctx.esc(s.name)}"><i></i>${ctx.esc(s.name)}</button>`).join('')}` : ''}
      ${!hubs.length && !sts.length ? '<p class="text-muted">没有匹配的地点</p>' : ''}
    </div>
    ${ctx.structs ? `<button type="button" class="btn btn-ghost btn-sm ap-cmp-manage" data-ap-cmp-manage>${scope ? '搜索 / 添加更多玩家建筑…' : '绑定 ESI 后可添加玩家建筑…'}</button>` : ''}`;
}
function openCmpPop(btn) {
  closeCmpPop();
  const pop = document.createElement('div');
  pop.className = 'ap-cmp-pop';
  pop.innerHTML = cmpPopHtml();
  btn.closest('.ap-cmp-head').append(pop);
  pop.querySelector('[data-ap-cmp-q]').focus();
  pop.addEventListener('input', (e) => {
    if (!e.target.matches('[data-ap-cmp-q]')) return;
    const q = e.target.value;
    pop.innerHTML = cmpPopHtml(q);
    const inp = pop.querySelector('[data-ap-cmp-q]');
    inp.focus();
    inp.setSelectionRange(q.length, q.length);
  });
}
function closeCmpPop() { document.querySelector('.ap-cmp-pop')?.remove(); }
document.addEventListener('click', (e) => { if (!e.target.closest?.('.ap-cmp-pop, [data-ap-cmp-add]')) closeCmpPop(); });

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
    volUsed: sum(rows, (r) => r.vol && r.batches * r.portion * r.vol),
    volBuy: sum(rows, (r) => r.vol && r.rpBuy),
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
      ${ctx.addToCart ? '<button type="button" class="btn btn-ghost" data-ap-cart title="把这些物品和数量加入购物车，可复制为游戏批量购买清单">全部加入购物车</button>' : ''}
    </div>`;
  $('apResult').innerHTML = tabs + (A.view === 'reproc' && rp ? reprocHtml(R, rp) : marketHtml(R, rp)) + foot;
  // 技能列表跟着物品变（只列用到的矿石处理技能）
  renderPanels();
}

// 买卖中间价（split）：（最低卖价 + 最高收价）÷ 2，卖单、收单都有才算；返回合计与有价种数
function applySplit(R) {
  for (const r of R.rows) r.split = r.sell != null && r.buy != null ? (r.sell + r.buy) / 2 : null;
  const priced = R.rows.filter((r) => r.split != null);
  return { total: priced.reduce((t, r) => t + r.qty * r.split, 0), n: priced.length };
}

// 按当前选的天数给每行填上成交中位价（mid），返回合计与有价种数
function applyMed(R) {
  const days = ctx.valuation.medDays();
  for (const r of R.rows) r.mid = r.med?.[days] ?? null;
  const priced = R.rows.filter((r) => r.mid != null);
  return { days, total: priced.reduce((t, r) => t + r.qty * r.mid, 0), n: priced.length };
}

function marketHtml(R, rp) {
  const isk = cpu;
  const T = cmpTotals(R);
  const f = fees();
  const M = R.hasMed ? applyMed(R) : null;
  const SP = applySplit(R);
  const sellNet = R.sellTotal * (1 - f.sales - f.broker), buyNet = R.buyTotal * (1 - f.sales);
  const sortKey = A.sort || 'sell';
  const rows = R.rows.slice().sort(sortKey === 'm3' ? (a, b) => (perM3(b.buy, b) ?? -1) - (perM3(a.buy, a) ?? -1)
    : (a, b) => ((b.qty * (b[sortKey] ?? 0)) - (a.qty * (a[sortKey] ?? 0))));
  const body = rows.map((r) => {
    const short = r.buy != null && r.depthSell.filled < r.qty;
    return `<tr>
      <td><div class="ap-item"><img src="${ICON(r.id)}" data-item-pop="${r.id}" alt="" width="28" height="28" loading="lazy"><span><span class="ap-name-row"><a href="#type=${r.id}" title="查看市场">${ctx.esc(r.name)}</a>${ctx.favStar ? ctx.favStar(r.id) : ''}</span><small class="ap-unit">单价 卖 ${isk(r.sell)} · 收 ${isk(r.buy)}${perM3(r.buy, r) != null ? ` · 收 ${ctx.formatISK(perM3(r.buy, r))}/m³` : ''}</small></span></div></td>
      <td class="num">${ctx.formatNumber(r.qty)}${r.vol ? `<small class="ap-muted">${fmtM3(r.qty * r.vol)}</small>` : ''}</td>
      <td class="num ap-sell ap-hide-sm">${isk(r.sell)}</td>
      <td class="num ap-buy ap-hide-sm">${isk(r.buy)}</td>
      <td class="num ap-buy ap-hide-sm">${isk(perM3(r.buy, r))}</td>
      <td class="num ap-sell ap-strong">${cp(r.sell == null ? null : r.qty * r.sell)}</td>
      <td class="num ap-buy ap-strong">${cp(r.buy == null ? null : r.qty * r.buy)}${short ? `<small title="收单总量不够">收单只够 ${ctx.formatNumber(r.depthSell.filled)}</small>` : ''}</td>
      <td class="num ap-hide-sm">${r.split == null ? '—' : `<span title="单价 ${ctx.formatISK(r.split)}">${cp(r.qty * r.split)}</span>`}</td>
      ${M ? `<td class="num ap-mid">${r.mid == null ? '—' : `<span title="单价 ${ctx.formatISK(r.mid)}">${cp(r.qty * r.mid)}</span>`}</td>` : ''}
      <td class="num ap-hide-sm">${cp(r.avg == null ? null : r.qty * r.avg)}</td>
      ${T.map((x) => { const o = x.get(r.id); return `<td class="num ap-cmp-cell">${!x.ready ? '<span class="ap-muted">…</span>' : `<span class="ap-sell${o.sell != null && r.sell != null && o.sell < r.sell ? ' is-better' : ''}" title="卖单小计（最低卖价 ${ctx.formatISK(o.sell ?? 0)}）">${cp(o.sell == null ? null : r.qty * o.sell)}</span><span class="ap-buy${o.buy != null && r.buy != null && o.buy > r.buy ? ' is-better' : ''}" title="收单小计（最高收价 ${ctx.formatISK(o.buy ?? 0)}）">${cp(o.buy == null ? null : r.qty * o.buy)}</span>`}</td>`; }).join('')}
    </tr>`;
  }).join('');
  const notes = [ratioNote()].filter(Boolean);
  if (R.shortBuy.length) notes.push(`${R.shortBuy.length} 种收单量不够，全部卖给收单约 <b>${fmtK(R.depthSellTotal)}</b>`);
  if (R.noSell.length) notes.push(`${R.noSell.length} 种在${ctx.esc(R.region.hub.name)}没有卖单：${R.noSell.slice(0, 6).map((r) => ctx.esc(r.name)).join('、')}${R.noSell.length > 6 ? ' 等' : ''}`);
  if (R.noBuy.length) notes.push(`${R.noBuy.length} 种没有收单`);
  if (R.unknown.length) notes.push(`<span class="ap-warn">${R.unknown.length} 行没认出来：${R.unknown.slice(0, 5).map((l) => ctx.esc(l.slice(0, 30))).join('、')}${R.unknown.length > 5 ? ' 等' : ''}</span>`);
  return `
    <div class="ap-stats${M ? ' has-mid' : ''}">
      <div class="ap-stat-sell ap-cp"${cpCard(R.sellTotal)}><span>按最低卖价</span><b>${fmtK(R.sellTotal)}</b><small>挂卖单税后 <em>${cp(sellNet)}</em>（−${pct2(f.sales + f.broker)}）</small></div>
      <div class="ap-stat-buy ap-cp"${cpCard(R.buyTotal)}><span>按最高收价</span><b>${fmtK(R.buyTotal)}</b><small>卖给收单税后 <em>${cp(buyNet)}</em>（−${pct2(f.sales)}）</small></div>
      <div class="ap-cp"${cpCard(SP.total)}><span title="（最低卖价 + 最高收价）÷ 2，卖单和收单都有的物品才计入">按买卖中间价</span><b>${fmtK(SP.total)}</b><small>${SP.n}/${R.rows.length} 种同时有卖单和收单</small></div>
      ${M ? `<div class="ap-stat-mid ap-cp"${cpCard(M.total)}><span title="${ctx.esc(R.region.hub.name)} 每日成交均价的中位数（与倒卖排行同一数据），不受挂单乱价影响">按成交中位价</span><b>${fmtK(M.total)}</b><small>${M.n}/${R.rows.length} 种有成交价${ctx.valuation.medDaysPicker(M.days)}</small></div>` : ''}
      <div class="ap-cp"${cpCard(R.avgTotal)}><span>全服均价</span><b>${fmtK(R.avgTotal)}</b><small>${R.rows.length} 种 · ${ctx.formatNumber(R.rows.reduce((t, r) => t + r.qty, 0))} 件${R.volTotal ? ` · ${fmtM3(R.volTotal)}` : ''}</small></div>
    </div>
    ${rp && rp.rows.length ? `<button type="button" class="ap-rp-hint" data-ap-view="reproc">化矿后产物按收单约 <b>${fmtK(rp.buyTotal)}</b>${rp.directTotal ? `，${rp.buyTotal >= rp.directTotal ? '比直接卖收单多' : '比直接卖收单少'} ${pct(Math.abs(rp.buyTotal / rp.directTotal - 1))}` : ''} →</button>` : ''}
    ${notes.length ? `<ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
    ${cmpHtml(R, T)}
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr>
        <th>物品</th><th class="num">数量</th><th class="num ap-hide-sm">最低卖价</th><th class="num ap-hide-sm">最高收价</th>
        <th class="num ap-hide-sm"><button type="button" data-ap-sort="m3" class="${sortKey === 'm3' ? 'active' : ''}" title="最高收价 ÷ 包装体积，点击按它排序">收价/m³</button></th>
        <th class="num"><button type="button" data-ap-sort="sell" class="${sortKey === 'sell' ? 'active' : ''}">卖单小计</button></th>
        <th class="num"><button type="button" data-ap-sort="buy" class="${sortKey === 'buy' ? 'active' : ''}">收单小计</button></th>
        <th class="num ap-hide-sm"><button type="button" data-ap-sort="split" class="${sortKey === 'split' ? 'active' : ''}">中间价小计</button></th>
        ${M ? `<th class="num"><button type="button" data-ap-sort="mid" class="${sortKey === 'mid' ? 'active' : ''}">成交价小计</button></th>` : ''}
        <th class="num ap-hide-sm"><button type="button" data-ap-sort="avg" class="${sortKey === 'avg' ? 'active' : ''}">均价小计</button></th>
        ${T.map((x) => `<th class="num ap-cmp-th" title="${ctx.esc(x.name)}：上 卖单小计 / 下 收单小计">${ctx.esc(x.name)}<small>卖 / 收</small></th>`).join('')}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>合计</td><td class="num">${R.volTotal ? `<small class="ap-muted">${fmtM3(R.volTotal)}</small>` : ''}</td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="num ap-buy ap-hide-sm">${R.volTotal ? isk(R.volBuy / R.volTotal) : ''}</td><td class="num ap-sell ap-strong">${cp(R.sellTotal)}</td><td class="num ap-buy ap-strong">${cp(R.buyTotal)}</td><td class="num ap-hide-sm ap-strong">${cp(SP.total)}</td>${M ? `<td class="num ap-mid ap-strong">${cp(M.total)}</td>` : ''}<td class="num ap-hide-sm">${cp(R.avgTotal)}</td>${T.map((x) => `<td class="num ap-cmp-cell">${x.ready ? `<span class="ap-sell">${cp(x.nSell ? x.sell : null)}</span><span class="ap-buy">${cp(x.nBuy ? x.buy : null)}</span>` : ''}</td>`).join('')}</tr>
        <tr class="ap-net"><td>税后</td><td></td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="ap-hide-sm"></td><td class="num ap-sell">${cp(sellNet)}</td><td class="num ap-buy">${cp(buyNet)}</td><td class="ap-hide-sm"></td>${M ? '<td></td>' : ''}<td class="ap-hide-sm"></td>${T.map(() => '<td></td>').join('')}</tr></tfoot>
    </table></div>`;
}

function reprocHtml(R, rp) {
  const isk = cp;
  const fmt = ctx.formatNumber;
  const diff = rp.directTotal ? rp.buyTotal / rp.directTotal - 1 : null;
  const f = fees();
  const items = rp.rows.slice().sort((a, b) => b.rpBuy - a.rpBuy).map((r) => {
    const better = r.direct == null ? null : r.rpBuy > r.direct;
    return `<tr>
      <td><div class="ap-item"><img src="${ICON(r.id)}" data-item-pop="${r.id}" alt="" width="28" height="28" loading="lazy"><span><span class="ap-name-row"><a href="#type=${r.id}" title="查看市场">${ctx.esc(r.name)}</a>${ctx.favStar ? ctx.favStar(r.id) : ''}</span><small class="ap-unit">${pct(r.y)} · ${ctx.esc(A.rp.skills[r.skill || SKILL.scrap] || '')}</small></span></div></td>
      <td class="num">${fmt(r.qty)}${r.left ? `<small title="不足一批（${fmt(r.portion)} 个）的部分不会化掉">剩 ${fmt(r.left)}</small>` : ''}</td>
      <td class="num ap-hide-sm" title="${ctx.esc(A.rp.skills[r.skill || SKILL.scrap] || '')}">${pct(r.y)}</td>
      <td class="num ap-buy ap-strong">${r.batches ? cp(r.rpBuy) : '—'}${r.missing ? `<small>${r.missing} 种产物没有收单</small>` : ''}</td>
      <td class="num ap-buy">${r.batches && r.vol ? cpu(r.rpBuy / (r.batches * r.portion * r.vol)) : '—'}${perM3(r.buy, r) != null ? `<small class="ap-muted" title="原物品直接卖收单的每 m³ 价值">直接卖 ${ctx.formatISK(perM3(r.buy, r))}</small>` : ''}</td>
      <td class="num ap-hide-sm">${isk(r.direct)}</td>
      <td>${!r.batches ? '<span class="ap-tag">不足一批</span>' : better == null ? '<span class="ap-tag ap-tag-rp">化矿</span>' : better ? `<span class="ap-tag ap-tag-rp">化矿 +${pct(r.direct ? r.rpBuy / r.direct - 1 : 1)}</span>` : `<span class="ap-tag ap-tag-sell">直接卖</span>`}</td>
    </tr>`;
  }).join('');
  const mats = rp.mats.map((m) => `<tr>
      <td><div class="ap-item"><img src="${ICON(m.id)}" data-item-pop="${m.id}" alt="" width="28" height="28" loading="lazy"><span><span class="ap-name-row"><a href="#type=${m.id}" title="查看市场">${ctx.esc(m.name)}</a>${ctx.favStar ? ctx.favStar(m.id) : ''}</span><small class="ap-unit">收 ${cpu(m.buy)} · 卖 ${cpu(m.sell)}</small></span></div></td>
      <td class="num">${fmt(m.qty)}</td>
      <td class="num ap-buy ap-hide-sm">${cpu(m.buy)}</td>
      <td class="num ap-buy ap-strong">${cp(m.buy == null ? null : m.qty * m.buy)}</td>
      <td class="num ap-sell">${cp(m.sell == null ? null : m.qty * m.sell)}</td>
    </tr>`).join('');
  const notes = [ratioNote()].filter(Boolean);
  notes.push(`化矿率：${rp.oreYield != null ? `矿石 / 冰矿 ${rp.oreYield} · ` : ''}碎铁 ${pct(yieldFor(0))}（${locLabel()}${TF.settings().src === 'char' ? (TF.character() ? ' · ' + ctx.esc(TF.character().name) + ' 的技能' : ' · <span class="ap-warn">角色技能未读取，按 0 级算</span>') : ''}）`);
  if (locWarn()) notes.push(`<span class="ap-warn">${ctx.esc(locWarn() + '，上面按能化矿算')}</span>`);
  if (S.tax) notes.push(`已扣再处理税 ${S.tax}%（约 ${fmtK(rp.taxTotal)}）`);
  if (rp.leftover.length) notes.push(`${rp.leftover.length} 种有零头化不掉：${rp.leftover.slice(0, 4).map((r) => ctx.esc(r.name)).join('、')}${rp.leftover.length > 4 ? ' 等' : ''}`);
  if (rp.skip.length) notes.push(`${rp.skip.length} 种不能化矿：${rp.skip.slice(0, 6).map((r) => ctx.esc(r.name)).join('、')}${rp.skip.length > 6 ? ' 等' : ''}`);
  if (R.unknown.length) notes.push(`<span class="ap-warn">${R.unknown.length} 行没认出来</span>`);
  if (!rp.rows.length) return `<ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul><div class="ap-empty">这些物品都不能化矿</div>`;
  return `
    <div class="ap-stats">
      <div class="ap-stat-buy ap-cp"${cpCard(rp.buyTotal)}><span>化矿产物·按收单</span><b>${fmtK(rp.buyTotal)}</b><small>卖给收单税后 <em>${cp(rp.buyTotal * (1 - f.sales))}</em></small></div>
      <div class="ap-stat-sell ap-cp"${cpCard(rp.sellTotal)}><span>化矿产物·按卖单</span><b>${fmtK(rp.sellTotal)}</b><small>挂卖单税后 <em>${cp(rp.sellTotal * (1 - f.sales - f.broker))}</em></small></div>
      <div class="ap-cp"${cpCard(rp.directTotal || null)}><span>原物品直接卖收单</span><b>${isk(rp.directTotal || null)}</b><small>${rp.directTotal ? `税后 ${fmtK(rp.directTotal * (1 - f.sales))} · ` : ''}${diff == null ? '原物品没有收单' : diff >= 0 ? `化矿多 <em class="ap-up">${pct(diff)}</em>` : `化矿少 <em class="ap-down">${pct(-diff)}</em>`}</small></div>
    </div>
    <ul class="ap-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr><th>物品</th><th class="num">数量</th><th class="num ap-hide-sm">化矿率</th><th class="num">化矿价值</th><th class="num" title="化矿产物按收单的价值 ÷ 化掉的原物品包装体积">每 m³</th><th class="num ap-hide-sm">直接卖收单</th><th>建议</th></tr></thead>
      <tbody>${items}</tbody>
      <tfoot><tr><td>合计</td><td></td><td class="ap-hide-sm"></td><td class="num ap-buy ap-strong">${cp(rp.buyTotal)}</td><td class="num ap-buy">${rp.volUsed ? cpu(rp.volBuy / rp.volUsed) : ''}</td><td class="num ap-hide-sm">${isk(rp.directTotal || null)}</td><td></td></tr></tfoot>
    </table></div>
    <h3 class="ap-sub">化矿产物</h3>
    <div class="ap-table-wrap"><table class="ap-table">
      <thead><tr><th>产物</th><th class="num">数量</th><th class="num ap-hide-sm">最高收价</th><th class="num">收单小计</th><th class="num">卖单小计</th></tr></thead>
      <tbody>${mats}</tbody>
      <tfoot><tr><td>合计${S.tax ? '（税前）' : ''}</td><td></td><td class="ap-hide-sm"></td><td class="num ap-buy ap-strong">${cp(rp.mats.reduce((t, m) => t + (m.buy == null ? 0 : m.qty * m.buy), 0))}</td><td class="num ap-sell ap-strong">${cp(rp.mats.reduce((t, m) => t + (m.sell == null ? 0 : m.qty * m.sell), 0))}</td></tr></tfoot>
    </table></div>`;
}

function resultText() {
  const R = A.result;
  const isk = (v) => (v == null ? '—' : Math.round(v * K()).toLocaleString('zh-CN'));
  const rp = A.rpResult;
  const ratio = A.ratio === 100 ? '' : `，按 ${A.ratio}% 计`;
  const f = fees();
  const M = R.hasMed ? applyMed(R) : null;
  const SP = applySplit(R);
  if (A.view === 'reproc' && rp) {
    return [
      `化矿估价（${R.region.hub.name}，矿石 ${rp.oreYield ?? '—'} · 碎铁 ${pct(yieldFor(0))}${S.tax ? ' · 税 ' + S.tax + '%' : ''}${ratio}）`,
      ...rp.mats.map((m) => `${m.name} ×${m.qty}　收 ${isk(m.buy == null ? null : m.buy * m.qty)}`),
      `合计：产物按最高收价 ${isk(rp.buyTotal)} ISK，按最低卖价 ${isk(rp.sellTotal)} ISK；原物品直接卖收单 ${isk(rp.directTotal)} ISK`,
      `税后：产物卖给收单 ${isk(rp.buyTotal * (1 - f.sales))} ISK，挂卖单 ${isk(rp.sellTotal * (1 - f.sales - f.broker))} ISK（销售税 ${pct2(f.sales)} · 中介费 ${pct2(f.broker)}）`
    ].join('\n');
  }
  return [
    `估价（${R.region.hub.name}${ratio}）`,
    ...R.rows.map((r) => `${r.name} ×${r.qty}　卖 ${isk(r.sell == null ? null : r.sell * r.qty)}　收 ${isk(r.buy == null ? null : r.buy * r.qty)}` + (M ? `　成交 ${isk(r.mid == null ? null : r.mid * r.qty)}` : '')),
    `合计：按最低卖价 ${isk(R.sellTotal)} ISK，按最高收价 ${isk(R.buyTotal)} ISK，按买卖中间价 ${isk(SP.total)} ISK` + (M ? `，按近 ${M.days} 天成交中位价 ${isk(M.total)} ISK` : ''),
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

// ---------- 化矿地点：指定建筑 / 当前位置 ----------
const ASSET_SCOPE = 'esi-assets.read_corporation_assets.v1';
const CORP_ST_SCOPE = 'esi-corporations.read_structures.v1';
const LOC_SCOPE = 'esi-location.read_location.v1';
// q 搜索词；corp 我的军团；corpList 军团建筑（空间站管理员）；npc NPC 空间站 [[id, 名称]]；here* 当前位置读取状态；busy / err 指定建筑读取状态
const P = { q: '', corp: null, corpList: null, corpLoading: null, npc: null, hereBusy: false, hereMsg: '', hereAt: 0, busy: false, err: '' };
const validLoc = (l) => Boolean(l && typeof l === 'object' && (l.k === 'npc' || l.k === 'st') && (l.id > 0 || l.key));
const curLoc = () => (S.mode === 'pick' ? S.loc : S.mode === 'here' ? S.here : null);
const yPct = (v) => (v * 100).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '%';
const fmtSec = (v) => (v == null ? '' : (v > 0 && v < 0.05 ? 0.1 : Math.round(v * 10) / 10).toFixed(1));
const SEC_NAME = ['高安', '低安', '00 / 虫洞'];

function myCorp() {
  const t = ctx.readToken?.();
  if (!t?.access_token) return Promise.resolve(0);
  if (P.corp?.cid !== t.character_id) P.corp = { cid: t.character_id, p: ctx.fetchESI(`/characters/${t.character_id}/`).then((c) => c.corporation_id || 0).catch(() => 0) };
  return P.corp.p;
}
const secCache = new Map();
function sysSec(id) {
  if (!id) return Promise.resolve(null);
  if (!secCache.has(id)) secCache.set(id, ctx.fetchESI(`/universe/systems/${id}/`).then((x) => x.security_status ?? null).catch(() => { secCache.delete(id); return null; }));
  return secCache.get(id);
}
// 地点的基础化矿率（不含技能）：NPC 空间站按空间站；玩家建筑按船体与化矿改装件（ind-structs.js）
function locBase(L) {
  if (L.k === 'npc') {
    const e = Number.isFinite(L.eff) ? L.eff : 0.5;
    L.base = [e, e, e];
    L.scrap = e;
  } else if (IS.rigData()) {
    const b = IS.reprocBase(L.type, L.rigs, L.sec);
    L.base = b.ore;
    L.scrap = b.scrap;
  }
  return L;
}
const stationTax = (L) => Math.round((L.take ?? 0.05) * 1e4) / 100;
async function npcLoc(id) {
  const st = await ctx.fetchESI(`/universe/stations/${id}/`);
  return locBase({
    k: 'npc', id, name: ctx.officialName?.(id) || st.name, sys: st.system_id, type: st.type_id,
    eff: st.reprocessing_efficiency ?? 0.5, take: st.reprocessing_stations_take ?? 0.05, svc: (st.services || []).includes('reprocessing-plant')
  });
}
// 玩家建筑的化矿改装件：之前手动改过的（fresh = 点了重新读取时不算）> 军团资产里装在这座建筑上的（总监）> 制造页「我的建筑」里填的
async function readRigs(L, fresh = false) {
  L.rigErr = '';
  L.fit = null;
  const onlyRp = (list) => list.filter((id) => IS.rigData()?.rigs[id]?.rp);
  const prev = [S.loc, S.here].find((x) => x?.k === 'st' && ((L.id && x.id === L.id) || (L.key && x.key === L.key)) && x.rigSrc === 'manual');
  if (prev && !fresh) { L.rigs = prev.rigs.slice(); L.rigSrc = 'manual'; L.fit = prev.fit ?? null; return locBase(L); }
  if (L.id && ctx.hasScope?.(ASSET_SCOPE)) {
    try {
      const corp = await myCorp();
      const f = corp ? (await IS.corpFittings(ctx, corp, fresh)).get(L.id) : null;
      if (f) {
        L.rigs = onlyRp(f.filter((x) => /^RigSlot/.test(x.f)).map((x) => x.t));
        L.fit = f.some((x) => IS.isRpService(x.t));
        L.rigSrc = 'esi';
        return locBase(L);
      }
    } catch (e) { if (e.status === 403 || /403/.test(e.message)) L.rigErr = '读不到军团资产（需要总监职位）'; }
  }
  const saved = IS.structs().find((s) => (L.id && s.id === L.id) || (L.key && s.key === L.key));
  if (prev) { L.rigs = prev.rigs.slice(); L.rigSrc = 'manual'; }
  else if (saved && onlyRp(saved.rigs || []).length) { L.rigs = onlyRp(saved.rigs); L.rigSrc = 'list'; }
  else { L.rigs = []; L.rigSrc = ''; }
  return locBase(L);
}
// 玩家建筑：名称 / 类型 / 星系先用列表里的，没有就读 ESI（要能停靠）
async function structLoc(id, hint = null, fresh = false) {
  let { name = '', type = 0, sys = 0, key = '' } = hint || {};
  if (id && (!type || !sys)) {
    const v = ctx.structureNameMap?.()?.get(id);
    if (v?.n && v.t && v.s) ({ n: name, t: type, s: sys } = v);
    else {
      let info;
      try { info = await ctx.esiAuthFetch(`/universe/structures/${id}/`); } catch (e) { throw new Error(/403/.test(e.message) || e.status === 403 ? '没有这座建筑的停靠权限' : e.message); }
      ({ name, type_id: type, solar_system_id: sys } = info);
      ctx.structureNameMap?.()?.set(id, { n: name, s: sys, t: type, at: Date.now() });
      ctx.saveStructureNames?.();
    }
  }
  if (!IS.hullOf(type)) throw new Error('这座建筑装不了提炼设施');
  const L = { k: 'st', id: id || 0, key: key || (id ? String(id) : ''), name: name || IS.hullOf(type).n, type, sys, sec: await sysSec(sys) };
  return readRigs(L, fresh);
}
// 军团建筑（选建筑时列出来）：需要「军团管理」里的建筑权限与空间站管理员职位，读不到就不列
function loadCorpList() {
  if (P.corpLoading || !ctx.hasScope?.(CORP_ST_SCOPE)) return P.corpLoading;
  P.corpLoading = myCorp().then((corp) => (corp ? ctx.esiAuthFetchPaged(`/corporations/${corp}/structures/`, 5) : []))
    .then((list) => { P.corpList = (list || []).filter((s) => IS.hullOf(s.type_id)); }, () => { P.corpList = []; });
  return P.corpLoading;
}
async function readHere(force = false) {
  if (P.hereBusy || (!force && Date.now() - P.hereAt < 60e3)) return;
  const t = ctx.readToken?.();
  if (!t?.access_token) { P.hereMsg = ''; renderPanels(); return; }
  if (!ctx.hasScope?.(LOC_SCOPE)) { P.hereMsg = '授权里没有位置权限，请在个人中心重新绑定 ESI'; renderPanels(); return; }
  P.hereBusy = true; P.hereMsg = ''; renderPanels();
  try {
    await Promise.all([loadRigsData(), loadCorpList()]);
    const loc = await ctx.esiAuthFetch(`/characters/${t.character_id}/location/`);
    P.hereAt = Date.now();
    if (loc.station_id) {
      const moved = !(S.here?.k === 'npc' && S.here.id === loc.station_id);
      S.here = await npcLoc(loc.station_id);
      if (moved) S.tax = stationTax(S.here);
    } else if (loc.structure_id) {
      const c = (P.corpList || []).find((x) => x.structure_id === loc.structure_id);
      S.here = await structLoc(loc.structure_id, c ? { name: c.name, type: c.type_id, sys: c.system_id } : null, force);
    } else {
      S.here = null;
      P.hereMsg = [t.character_name || '', '在太空中，没有停靠', ctx.officialName?.(loc.solar_system_id) || String(loc.solar_system_id)].filter(Boolean).join(' · ');
    }
  } catch (e) { P.hereMsg = '读取当前位置失败：' + e.message; }
  P.hereBusy = false;
  save();
  renderRp();
}
async function pickLoc(kind, id, key = '') {
  closeLocPop();
  P.busy = true; P.err = ''; renderPanels();
  try {
    await loadRigsData();
    if (kind === 'npc') {
      S.loc = await npcLoc(id);
      S.tax = stationTax(S.loc);
    } else {
      const s = key ? IS.structs().find((x) => x.key === key) : null;
      const c = (P.corpList || []).find((x) => x.structure_id === id);
      const hint = s ? { name: s.name, type: s.type, sys: s.system, key: s.key } : c ? { name: c.name, type: c.type_id, sys: c.system_id } : null;
      S.loc = await structLoc(id || s?.id || 0, hint);
    }
    S.mode = 'pick';
  } catch (e) { P.err = '读取失败：' + e.message; }
  P.busy = false;
  save();
  renderRp();
}
async function reloadLoc() {
  if (S.mode === 'here') { readHere(true); return; }
  const L = S.loc;
  if (!L) return;
  P.busy = true; P.err = ''; renderPanels();
  try {
    await loadRigsData();
    S.loc = L.k === 'npc' ? await npcLoc(L.id) : await structLoc(L.id, { name: L.name, type: L.type, sys: L.sys, key: L.key }, true);
  } catch (e) { P.err = '读取失败：' + e.message; }
  P.busy = false;
  save();
  renderRp();
}
let rigsLoading = null;
function loadRigsData() {
  IS.useStore(ctx.store);
  if (!rigsLoading) rigsLoading = IS.loadRigs().then(() => {
    // 改装件数据到了：之前存下的建筑按最新数据重算
    for (const L of [S.loc, S.here]) if (L?.k === 'st') locBase(L);
  }).catch((e) => { rigsLoading = null; throw e; });
  return rigsLoading;
}

// 选建筑：我的建筑（制造页）、军团建筑、读过的玩家建筑、NPC 空间站，可搜索；也可以贴建筑 ID 或游戏内链接
function locPopHtml(q = '') {
  const { esc } = ctx;
  const lq = q.trim().toLowerCase();
  const hit = (s) => !lq || String(s || '').toLowerCase().includes(lq);
  const hullName = (t) => IS.hullOf(t)?.n || '';
  const sysName = (id) => ctx.officialName?.(id) || '';
  const btn = (v, name, sub, st) => `<button type="button" data-ap-loc="${esc(v)}">${st ? '<i></i>' : ''}<span>${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
  const mine = IS.rigData() ? IS.structs().filter((s) => hit(s.name || hullName(s.type)) || hit(sysName(s.system))) : [];
  const seen = new Set(mine.map((s) => s.id).filter(Boolean));
  const corp = (P.corpList || []).filter((s) => !seen.has(s.structure_id) && (hit(s.name) || hit(sysName(s.system_id))));
  corp.forEach((s) => seen.add(s.structure_id));
  const known = lq.length >= 2 && IS.rigData() ? [...(ctx.structureNameMap?.() || [])].filter(([id, v]) => v?.n && IS.hullOf(v.t) && !seen.has(id) && hit(v.n)).slice(0, 20) : [];
  const npc = lq.length >= 2 && P.npc ? P.npc.filter(([, n]) => hit(n)).slice(0, 30) : [];
  const idm = q.match(/showinfo:\d+\/\/(\d{8,})/) || q.match(/^\s*(\d{8,})\s*$/);
  const id = idm ? Number(idm[1]) : 0;
  const idBtn = id >= 60000000 && id < 64000000 ? btn('npc:' + id, `NPC 空间站 ${id}`, '按 ID 读取') : id >= 1e12 ? btn('st:' + id, `玩家建筑 ${id}`, '按 ID 读取（要能停靠）', true) : '';
  const groups = [
    idBtn && `<div class="ap-cmp-group">按 ID</div>${idBtn}`,
    mine.length && `<div class="ap-cmp-group">我的建筑（制造页）</div>${mine.map((s) => btn((s.id ? 'st:' + s.id : 'st:0') + ':' + s.key, s.name || hullName(s.type), [hullName(s.type), sysName(s.system)].filter(Boolean).join(' · '), true)).join('')}`,
    corp.length && `<div class="ap-cmp-group">军团建筑</div>${corp.map((s) => btn('st:' + s.structure_id, s.name, [hullName(s.type_id), sysName(s.system_id)].filter(Boolean).join(' · '), true)).join('')}`,
    known.length && `<div class="ap-cmp-group">玩家建筑</div>${known.map(([sid, v]) => btn('st:' + sid, v.n, hullName(v.t), true)).join('')}`,
    npc.length && `<div class="ap-cmp-group">NPC 空间站</div>${npc.map(([sid, n]) => btn('npc:' + sid, n, '')).join('')}`
  ].filter(Boolean);
  return `<input type="search" class="cr-input" data-ap-loc-q placeholder="${esc(tr('搜索 NPC 空间站 / 玩家建筑，或贴建筑 ID'))}" value="${esc(q)}" autocomplete="off">
    <div class="ap-cmp-list">${groups.join('') || `<p class="text-muted">${lq.length >= 2 ? '没有匹配的地点' : '输入至少两个字搜索 NPC 空间站和读过的玩家建筑'}</p>`}</div>`;
}
function openLocPop(btn) {
  closeLocPop();
  P.q = '';
  const pop = document.createElement('div');
  pop.className = 'ap-loc-pop';
  const draw = () => {
    const q = pop.querySelector('[data-ap-loc-q]')?.value ?? P.q;
    pop.innerHTML = locPopHtml(q);
    const inp = pop.querySelector('[data-ap-loc-q]');
    inp.focus();
    inp.setSelectionRange(q.length, q.length);
  };
  pop.innerHTML = locPopHtml(P.q);
  btn.closest('.ap-loc-pick').append(pop);
  pop.querySelector('[data-ap-loc-q]').focus();
  pop.addEventListener('input', (e) => { if (e.target.matches('[data-ap-loc-q]')) { P.q = e.target.value; draw(); } });
  // NPC 空间站名称表、改装件数据、军团建筑读完后刷新列表
  Promise.all([
    P.npc ? null : ctx.loadNpcNames?.().then((d) => { P.npc = Object.entries(d?.stations || {}).map(([id, n]) => [Number(id), n]); }),
    loadRigsData().catch(() => {}), loadCorpList()
  ]).then(() => { if (pop.isConnected) draw(); });
}
function closeLocPop() { document.querySelector('.ap-loc-pop')?.remove(); }
document.addEventListener('click', (e) => { if (!e.target.closest?.('.ap-loc-pop, [data-ap-loc-open]')) closeLocPop(); });
// 页面翻译不处理 placeholder，这里自己翻
const tr = (s) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(s) : s);

// 选中地点的说明卡片：类型 / 星系 / 基础化矿率；玩家建筑带改装件（可手动改）。指定建筑时名称已在选择按钮上，卡片里不重复
function locCardHtml(L, named = false) {
  const { esc } = ctx;
  const sys = L.sys ? `${esc(ctx.officialName?.(L.sys) || '')}${L.sec != null ? ` ${fmtSec(L.sec)}` : ''}` : '';
  const warn = [];
  let info, rigs = '';
  if (L.k === 'npc') {
    info = ['NPC 空间站', sys, `基础化矿率 ${yPct(L.base?.[0] ?? 0.5)}`, `基础税 ${stationTax(L)}%`].filter(Boolean).join(' · ');
    if (L.svc === false) warn.push('这个空间站没有精炼服务，不能化矿');
  } else {
    const h = IS.hullOf(L.type);
    info = [h?.n || '', sys, L.sec != null ? SEC_NAME[IS.secCol(L.sec)] : '', h?.rp ? `船体化矿 +${h.rp}%` : ''].filter(Boolean).join(' · ');
    const opts = IS.rigData() ? IS.rpRigOptions(L.type) : [];
    const sel = (i) => `<select class="cr-input" data-ap-rig="${i}" aria-label="化矿改装件 ${i + 1}"><option value="">无化矿改装件</option>${opts.map(([id, n]) => `<option value="${id}"${L.rigs?.[i] === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    const src = { esi: '改装件读自军团资产', list: '改装件来自制造页「我的建筑」', manual: '改装件为手动选择' }[L.rigSrc] || (L.rigErr ? '' : '读不到这座建筑的装配，改装件请手动选');
    rigs = `<div class="ap-loc-rigs">${[0, 1, 2].map(sel).join('')}</div>${[L.rigErr, src].filter(Boolean).map((t) => `<small>${esc(t)}</small>`).join('')}`;
    if (L.fit === false) warn.push('军团资产里这座建筑没有装提炼设施，不能化矿');
  }
  const b = L.base || [0.5, 0.5, 0.5];
  const reload = '<button type="button" class="icon-btn small" data-ap-loc-reload title="重新读取" aria-label="重新读取"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>';
  return `<div class="ap-loc">
      ${named ? `<div class="ap-loc-name"><b>${esc(L.name)}</b></div><small>${info}</small>` : `<div class="ap-loc-name"><small>${info}</small>${reload}</div>`}
      ${rigs}
      <div class="ap-loc-yield"><span>矿石 <b>${yPct(b[0])}</b></span><span>卫星矿 <b>${yPct(b[1])}</b></span><span>冰矿 <b>${yPct(b[2])}</b></span><small>不含技能</small></div>
      ${warn.map((w) => `<small class="ap-warn">${esc(w)}</small>`).join('')}
    </div>`;
}
function hereHtml() {
  const { esc } = ctx;
  if (!ctx.hasEsiToken()) return '<p class="ap-rp-tip">绑定 ESI 后读取角色当前停靠的空间站或建筑 <button type="button" class="link-btn" data-ap-bind>去绑定</button></p>';
  const t = ctx.readToken?.();
  const head = `<div class="ap-rp-row"><span>${esc(t?.character_name || '')}</span><button type="button" class="btn btn-ghost btn-sm" data-ap-loc-reload${P.hereBusy ? ' disabled' : ''}>${P.hereBusy ? '读取中…' : '重新读取位置'}</button></div>`;
  return head + (P.hereMsg ? `<p class="ap-rp-tip ap-warn">${esc(P.hereMsg)}</p>` : '') + (S.here && !P.hereMsg ? locCardHtml(S.here, true) : '');
}
function locLabel() {
  if (S.mode === 'type') return S.station === 'npc' ? 'NPC 空间站' : S.station === 'athanor' ? '阿塔诺' : '塔塔拉';
  const L = curLoc();
  return L ? ctx.esc(L.name) : S.mode === 'here' ? '当前位置未读到，按 50% 算' : '未选建筑，按 50% 算';
}
// 地点不能化矿时的提示（结果页）
function locWarn() {
  const L = curLoc();
  if (L?.k === 'npc' && L.svc === false) return '这个空间站没有精炼服务';
  if (L?.k === 'st' && L.fit === false) return '这座建筑没有装提炼设施';
  return '';
}

function rpHtml() {
  const npc = S.station === 'npc';
  const mode = `<div class="ap-rp-row"><span>地点</span>${segHtml('mode', [['type', '按类型'], ['pick', '指定建筑'], ['here', '当前位置']])}</div>`;
  let body;
  if (S.mode === 'type') {
    body = `
    <div class="ap-rp-row"><span>类型</span>${segHtml('station', [['npc', 'NPC 空间站'], ['athanor', '阿塔诺'], ['tatara', '塔塔拉']])}</div>
    <div class="ap-rp-row"><span>改装件</span>${segHtml('rig', [[0, '无'], [1, 'T1'], [3, 'T2']], npc)}</div>
    <div class="ap-rp-row"><span>安全等级</span>${segHtml('sec', [['h', '高安'], ['l', '低安'], ['n', '00 / 虫洞']], npc || !S.rig)}</div>`;
  } else if (S.mode === 'pick') {
    body = `<div class="ap-loc-pick"><button type="button" class="cr-input ap-loc-btn" data-ap-loc-open${P.busy ? ' disabled' : ''}><span>${P.busy ? '读取中…' : S.loc ? ctx.esc(S.loc.name) : '选择 NPC 空间站或玩家建筑…'}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>
      ${P.err ? `<p class="ap-rp-tip ap-warn">${ctx.esc(P.err)}</p>` : ''}${S.loc ? locCardHtml(S.loc) : ''}`;
  } else body = hereHtml();
  return `${mode}${body}
    <div class="cr-fields">
      <label><span>植入体</span><select class="cr-input" data-ap-imp aria-label="提炼植入体">${[[0, '无'], [1, 'RX-801 +1%'], [2, 'RX-802 +2%'], [4, 'RX-804 +4%']].map(([v, l]) => `<option value="${v}"${S.imp === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label><span>再处理税 %</span><input class="cr-input" type="number" min="0" max="100" step="0.1" value="${S.tax}" data-ap-tax aria-label="再处理税"></label>
      <label title="手动加的化矿率加成，乘在矿石 / 卫星矿 / 冰矿上（比如装配读不到时补上）"><span>其它加成 %</span><input class="cr-input" type="number" min="-50" max="100" step="0.1" value="${S.extra}" data-ap-extra aria-label="其它加成"></label>
    </div>
    <p class="ap-rp-tip" title="改装件、建筑与安全等级加成只作用于矿石 / 冰矿 / 卫星矿；装备等按碎铁处理技术算">${S.mode === 'type' ? 'NPC 空间站声望 0 时再处理税约 5%' : '选 NPC 空间站时再处理税按该站基础税率（声望 0）填好，可以改'}</p>`;
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
  if (main.dataset.ready) { if (S.mode === 'here') readHere(); return; }
  main.dataset.ready = '1';
  main.innerHTML = `
    <section class="ap-page">
      <div class="ap-head"><h2>估价</h2></div>
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
          <label class="ap-ratio"><span>比例</span><input type="number" id="apRatio" class="cr-input" min="1" max="1000" step="1" value="${A.ratio}" inputmode="numeric" aria-label="比例"><span>%</span></label>
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
          <div class="ap-result" id="apResult"><div class="ap-empty">游戏里 Ctrl+C 物品，粘贴后点「估价」</div></div>
          <div id="apAby"></div>
        </div>
      </div>
    </section>`;
  $('apGo').addEventListener('click', appraise);
  $('apRatio').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!(v > 0)) return;
    A.ratio = Math.min(1000, v);
    save();
    if (A.result) render();
  });
  $('apRatio').addEventListener('change', (e) => { e.target.value = A.ratio; });
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
    const md = e.target.closest('[data-val-med]');
    if (md) { e.stopPropagation(); ctx.store.set('eve-valuation-med', md.dataset.valMed); render(); return; }
    // 点价格 / 价格卡片复制数字（卡片里的按钮、链接照常工作）
    const c = e.target.closest('[data-ap-cp]');
    if (c && !e.target.closest('a, button, select, input')) { ctx.copyText(c.dataset.apCp); return; }
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
    if (e.target.closest('[data-ap-cmp-add]')) { if (document.querySelector('.ap-cmp-pop')) closeCmpPop(); else openCmpPop(e.target.closest('[data-ap-cmp-add]')); return; }
    const pick = e.target.closest('[data-ap-cmp-pick]');
    if (pick) {
      const [k, id] = pick.dataset.apCmpPick.split(':');
      A.cmp.push(k === 'st' ? { k, id: Number(id), name: pick.dataset.name || '' } : { k, id: Number(id) });
      save(); closeCmpPop(); render(); loadCompare();
      return;
    }
    const del = e.target.closest('[data-ap-cmp-del]');
    if (del) { A.cmp.splice(Number(del.dataset.apCmpDel), 1); save(); render(); return; }
    if (e.target.closest('[data-ap-cmp-manage]')) { closeCmpPop(); ctx.structs?.open(); return; }
    if (e.target.closest('[data-ap-copy]')) ctx.copyText(resultText(), '已复制估价结果');
    if (e.target.closest('[data-ap-cart]')) ctx.addToCart(A.result.rows.map((r) => ({ id: r.id, qty: r.qty, name: r.name })));
  });
  const settings = $('apSettings');
  settings.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ap-set]');
    if (b && !b.disabled) {
      const k = b.dataset.apSet;
      S[k] = k === 'rig' ? Number(b.dataset.v) : b.dataset.v;
      save();
      renderRp();
      if (k === 'mode' && S.mode === 'here') readHere(true);
      if (k === 'mode' && S.mode !== 'type') loadRigsData().then(renderPanels, () => {});
      return;
    }
    const open = e.target.closest('[data-ap-loc-open]');
    if (open && !open.disabled) { if (document.querySelector('.ap-loc-pop')) closeLocPop(); else openLocPop(open); return; }
    const pick = e.target.closest('[data-ap-loc]');
    if (pick) { const [k, id, key] = pick.dataset.apLoc.split(':'); pickLoc(k, Number(id), key || ''); return; }
    if (e.target.closest('[data-ap-loc-reload]')) { reloadLoc(); return; }
    if (e.target.closest('[data-ap-bind]')) ctx.openEsiBind?.();
  });
  TF.bindForm(settings);
  // 共用设置在任何页面改动后都刷新估价（页面隐藏时也只是重算 HTML）
  TF.onChange(() => { renderRp(); syncImplants(); });
  settings.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-ap-imp]')) S.imp = Number(t.value);
    else if (t.matches('[data-ap-tax]')) S.tax = Math.min(100, Math.max(0, Number(t.value) || 0));
    else if (t.matches('[data-ap-extra]')) S.extra = Math.min(100, Math.max(-50, Number(t.value) || 0));
    else if (t.matches('[data-ap-rig]')) {
      const L = curLoc();
      if (!L || L.k !== 'st') return;
      const rigs = [0, 1, 2].map((i) => L.rigs?.[i] || 0);
      rigs[Number(t.dataset.apRig)] = Number(t.value) || 0;
      L.rigs = rigs.filter(Boolean);
      L.rigSrc = 'manual';
      locBase(L);
    } else return;
    save();
    renderRp();
  });
  renderPanels();
  if (TF.settings().src === 'char') TF.loadCharacter(true).then(syncImplants);
  loadReprocess().then(() => renderRp())
    .catch((e) => { $('apRpBody').innerHTML = `<div class="ap-warn">化矿数据载入失败：${ctx.esc(e.message)}</div>`; });
  if (S.mode !== 'type') loadRigsData().then(() => (A.rp ? renderRp() : null), () => {});
  if (S.mode === 'here') readHere();
  loadNames().catch(() => {});
}
