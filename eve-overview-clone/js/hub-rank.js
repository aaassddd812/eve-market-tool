// 市场中心 ·「倒卖排行」（#arb）：所有物品一起比交易中心差价，和 LP 商店全服排行一样按利润排序。
// 数据：击杀记录服务 GET /api/v1/hubs/arbitrage?server=，每 30 分钟汇总当前服务器五个交易中心的全部挂单
//      （每个物品每个交易中心：最低卖 / 最高收、最优价 5% 以内的深度）与星域日均成交（宁静服 EVE Ref 每日历史，国服逐个查 ESI，缓存 1 天）。
// 路线与利润的算法与单个物品的「交易中心比价」相同（hub-compare.js 的 calcRoutes），技能与税费用全站设置；每个物品只列筛选条件下最好的一条路线。
// 运费设置与单品比价共用（跨中心路线扣 包装体积 × 每立方运费 + 抵押费），可按每立方利润排序（适合按货舱容量选品）
// 我的建筑市场（struct-markets.js，需绑定 ESI）：浏览器用角色授权读勾选建筑的全部订单，按物品汇总后作为额外的买入 / 卖出地点加入排行；
//   建筑没有成交历史，和交易中心同星域时借用该交易中心的日均成交与均价，否则挂单方式算不出可做数量（直接成交方式不受影响）。
//   只比服务器汇总里有的物品（五个交易中心都没有挂单的物品不在排行里）。
// 自定义 NPC 市场（最多 3 个）：任选星域，可限定到一个星系；浏览器直接读 ESI 该星域的全部挂单（公开接口，缓存 10 分钟），
//   和玩家建筑一样作为额外的买入 / 卖出地点；星域里有交易中心时借用它的日均成交，否则挂单方式算不出可做数量。
// 排除列表：行末 × 把物品排除出排行（存在本浏览器），「已排除」里可以恢复。
// 按销量选品（mode = demand）：先看目标交易中心卖得多的物品（最近一天 / 7 天 / 30 天星域日均成交、7 天比 30 天的趋势、卖单库存够卖几天、
//   当前卖价比 30 天均价高多少、舰船近 7 天在击杀库里被打爆的艘数），再为每个物品找最好的进货方式：
//   别的交易中心（含玩家建筑 / 自定义市场）买卖单直接买来、或在任意地点挂收单收货（含目标市场本地），运到目标市场挂卖单。
//   建议数量 = 日均成交 × 份额 × 计划天数（不超过进货地的卖单深度 / 挂收单按进货地日均成交 × 份额）；按每天利润排行。
//   标签：无卖单（目标市场卖空了，卖价按 30 天成交均价估）、库存少（卖单不够卖 2 天）、成交上涨（7 天日均 ≥ 30 天 × 1.3）、
//   卖价偏高（最低卖价 ≥ 30 天均价 × 1.15）。「24 小时」是最近一个完整交易日（UTC），ESI 与 EVE Ref 只有按天的统计。
//   目标市场用搜索框选：交易中心、自定义 NPC 市场，也可以搜星域直接加为自定义市场（玩家建筑不能当目标，只能作为进货地）。
//   自定义市场的成交量借用同星域交易中心（整个星域的统计），库存天数用该市场自己的卖单；星域里没有交易中心时算不了。
// 消耗排行（mode = consume）：五大交易中心日均成交（可选 24 小时 / 7 天 / 30 天）加起来看什么东西用得多，宁静服再加上击杀库近 7 天被击毁数；
//   消耗额 = 五中心日成交额合计 + 日均被击毁数 × 均价（舰船、部署物被打爆后要补货）。列出最便宜的交易中心卖价，
//   启用了玩家建筑市场时再列建筑里的最低卖价与比交易中心贵多少，方便决定去哪里买、给建筑市场备什么货。
// 排序：点表头排序（再点一次换方向），普通倒卖按预计利润 / 利润率 / 每件利润 / 每立方利润排序时，每个物品也按这一项挑最好的路线。
// 分页：全部结果都能看，每页 50 / 100 / 200 / 500 条。
// 分类：打开倒卖排行时市场中心侧栏的物品目录换成分类列表（#arbSide），显示每个分类符合条件的物品数。
import { calcRoutes, ROUTE_SORT, MODES, setHubMode, loadVolumes, freight, setFreight, freightHtml } from './hub-compare.js?v=v7';

let ctx = null;   // server, regions, esc, formatISK, formatPrice, formatNumber, TF, typeName, category, isGlobal, iconUrl, openItem
const PAGE_SIZES = [50, 100, 200, 500];
const POLL = 4000;
const POLL_VOLUME = 20000;   // 服务器还在读成交量时，隔一会儿取一次新结果
const MIN_PROFIT = [[0, '不限'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿']];
const MIN_DAILY = [[0, '不限'], [10, '10'], [100, '100'], [1000, '1000']];
const DEMAND_MIN_DAY = [[0, '不限'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿']];
const DEMAND_MIN_TURN = [[0, '不限'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿']];
const DEMAND_MAX_STOCK = [[0, '不限'], [1, '1 天'], [3, '3 天'], [7, '7 天']];
// 表头排序：每种模式各列的取值（null 永远排最后），ASC 里的列第一次点按升序
const COLS = {
  route: { name: null, buy: (x) => x.r.buyAt, sell: (x) => x.r.sellAt, unit: (x) => x.r.unit, margin: (x) => x.r.margin, m3: (x) => x.r.perM3, qty: (x) => x.r.qty || null, cost: (x) => (x.r.qty ? x.r.cost * x.r.qty : null), profit: (x) => x.r.total },
  demand: { name: null, day: (x) => x.perDay, unit: (x) => x.r.unit, qty: (x) => x.r.qty || null, turn: (x) => x.turnover, trend: (x) => x.trend, stock: (x) => (x.soldOut ? 0 : x.stock), loss: (x) => x.loss },
  consume: { name: null, use: (x) => x.use, turn: (x) => x.turnover, units: (x) => x.units, loss: (x) => x.loss, trend: (x) => x.trend, price: (x) => x.cheap?.price ?? null, markup: (x) => (x.st && x.cheap ? x.st.price / x.cheap.price - 1 : null) }
};
const SORT_KEY = { route: 'sort', demand: 'dsort', consume: 'csort' };
const ASC = new Set(['name', 'buy', 'stock', 'price', 'markup']);
const modeKind = () => (F.mode === 'demand' ? 'demand' : F.mode === 'consume' ? 'consume' : 'route');
function sortState() {
  const m = modeKind();
  const k = COLS[m][F[SORT_KEY[m]]] !== undefined ? F[SORT_KEY[m]] : { route: 'profit', demand: 'day', consume: 'use' }[m];
  return { m, k, dir: F.sdir?.[m]?.[k] || (ASC.has(k) ? 'asc' : 'desc') };
}
function sortRows(rows) {
  const { m, k, dir } = sortState();
  const sk = JSON.stringify([S.key, k, dir]);
  if (S.sorted && S.sortedKey === sk && S.sortedFrom === rows) return S.sorted;
  const get = COLS[m][k] || ((x) => ctx.typeName(x.id));
  const sign = dir === 'asc' ? 1 : -1;
  const val = rows.map((x) => [x, get(x)]);
  val.sort(([x, a], [y, b]) => {
    if (x.off !== y.off) return x.off ? 1 : -1;
    const na = a == null || Number.isNaN(a), nb = b == null || Number.isNaN(b);
    if (na || nb) return na === nb ? 0 : na ? 1 : -1;
    return (typeof a === 'string' ? a.localeCompare(b, 'zh') : a - b) * sign;
  });
  S.sorted = val.map(([x]) => x);
  S.sortedKey = sk; S.sortedFrom = rows;
  return S.sorted;
}
const th = (k, label, cls = '', title = '') => {
  if (!k) return `<th${cls ? ` class="${cls}"` : ''}${title ? ` title="${title}"` : ''}>${label}</th>`;
  const { k: cur, dir } = sortState();
  const on = cur === k;
  return `<th class="sortable${cls ? ' ' + cls : ''}${on ? ' sorted' : ''}" data-hr-col="${k}" data-dir="${on ? dir : ''}" aria-sort="${on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0"${title ? ` title="${title}"` : ''}>${label}</th>`;
};
function pagerHtml(page, pages, total, from, to) {
  const w = matchMedia('(max-width: 768px)').matches ? 1 : 2;
  const nums = new Set([1, pages, ...Array.from({ length: w * 2 + 1 }, (_, i) => page - w + i)].filter((n) => n >= 1 && n <= pages));
  let last = 0, items = '';
  for (const n of [...nums].sort((a, b) => a - b)) {
    if (n - last > 1) items += '<span class="kb-pager-gap">…</span>';
    items += `<button type="button" data-hr-page="${n}" class="${n === page ? 'active' : ''}"${n === page ? ' aria-current="page"' : ''}>${n}</button>`;
    last = n;
  }
  return `<nav class="kb-pager hr-pager" aria-label="分页">
      <span class="hr-pager-sum">第 ${from}–${to} 个，共 ${total} 个</span>
      ${pages > 1 ? `<button type="button" data-hr-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="上一页">‹</button>${items}
      <button type="button" data-hr-page="${page + 1}"${page >= pages ? ' disabled' : ''} aria-label="下一页">›</button>
      <label class="kb-pager-jump">跳到 <input type="number" min="1" max="${pages}" value="${page}" data-hr-jump aria-label="跳到页码"> 页</label>` : ''}
      <label class="kb-pager-size">每页 <select data-hr-size aria-label="每页条数">${PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize() ? ' selected' : ''}>${n}</option>`).join('')}</select> 条</label>
    </nav>`;
}
const pageSize = () => (PAGE_SIZES.includes(Number(F.size)) ? Number(F.size) : 100);
const RISING = 1.3, TIGHT = 2, HIGH = 1.15;   // 成交上涨：7 天 / 30 天 ≥ 1.3；库存少：库存 < 2 天；卖价偏高：卖价 ≥ 均价 × 1.15
const F = { sdir: {}, size: 100, csort: 'use', lossOnly: false, target: 0, win: 7, share: 10, days: 3, minDay: 0, minTurn: 0, maxStock: 0, rising: false, dsort: 'day', mode: 'sb', sort: 'profit', from: 0, to: 0, local: true, cat: 0, minProfit: 1e7, minDaily: 0, strict: true, excl: [], custom: [] };   // excl：排除的物品 ID；custom：[{ region, name, system, sysName }]
const CUSTOM_MAX = 3;
const CUSTOM_TTL = 10 * 60e3;
const customCache = new Map();   // 市场 ID -> { at, quotes }
const S = { page: 1, pageKey: '', data: null, loading: null, error: null, q: '', timer: 0, rows: null, key: '', vols: {}, sm: [], smKey: '', smNote: '', cm: [], cmKey: '', cmNote: '', showCustom: false, tq: '', tOpen: false };
try { Object.assign(F, JSON.parse(localStorage.getItem('eve-hub-rank') || '{}')); } catch { /* 用默认 */ }
if (!Array.isArray(F.excl)) F.excl = [];
if (!Array.isArray(F.custom)) F.custom = [];
// 自定义市场的 ID：负数，不和交易中心 / 建筑 ID 冲突（星域 10000002 + 星系 30000142 → -2000142）
const customId = (c) => -((c.region % 1e6) * 1e6 + (c.system ? c.system % 1e6 : 0));
const save = () => { try { localStorage.setItem('eve-hub-rank', JSON.stringify(F)); } catch { /* 无痕模式 */ } };

export function initHubRank(context) {
  ctx = context;
  ctx.structs?.on(() => { S.smKey = ''; if (S.box?.isConnected && !S.box.hidden && S.data && !S.data.loading) loadStructs(S.box); });
}

// 勾选建筑的订单 → 每座建筑一张 物品 → 行情 表
async function loadStructs(box) {
  if (!ctx.structs?.count()) { S.sm = []; S.smKey = ''; S.smNote = ''; S.rows = null; return; }
  S.smNote = '正在读取玩家建筑市场…';
  if (box) render(box);
  const list = await ctx.structs.load((d, t) => { S.smNote = `正在读取玩家建筑市场 ${d}/${t}…`; const n = box?.querySelector('[data-hr-smnote]'); if (n) n.textContent = S.smNote; }).catch(() => []);
  S.sm = list.map(({ s, byType }) => {
    const quotes = new Map();
    for (const [tid, orders] of byType) quotes.set(tid, ctx.structs.quote(orders));
    return { s, quotes };
  });
  S.smKey = S.sm.map((x) => x.s.id).join(',') + '@' + Date.now();
  S.smNote = list.length ? `含 ${list.length} 座玩家建筑` : '';
  S.rows = null;
  if (box) render(box);
}

// 自定义 NPC 市场：读星域全部挂单（X-Pages 分页，8 路并发），可只留一个星系，按物品汇总成报价
async function loadCustom(box) {
  if (!F.custom.length) { S.cm = []; S.cmKey = ''; S.cmNote = ''; S.rows = null; return; }
  const out = [];
  for (const [n, c] of F.custom.entries()) {
    const id = customId(c);
    let hit = customCache.get(id);
    if (!hit || Date.now() - hit.at > CUSTOM_TTL) {
      S.cmNote = `正在读取 ${c.sysName || c.name} 的挂单（${n + 1}/${F.custom.length}）…`;
      if (box) { const el = box.querySelector('[data-hr-cmnote]'); if (el) el.textContent = S.cmNote; else render(box); }
      try {
        const orders = await regionOrders(c.region, (d, t) => {
          S.cmNote = `正在读取 ${c.sysName || c.name} 的挂单 ${d}/${t} 页…`;
          const el = box?.querySelector('[data-hr-cmnote]'); if (el) el.textContent = S.cmNote;
        });
        const byType = new Map();
        for (const o of orders) {
          if (c.system && o.system_id !== c.system) continue;
          if (!byType.has(o.type_id)) byType.set(o.type_id, []);
          byType.get(o.type_id).push(o);
        }
        const quotes = new Map();
        for (const [tid, list] of byType) quotes.set(tid, ctx.quote(list));
        hit = { at: Date.now(), quotes };
        customCache.set(id, hit);
      } catch (e) {
        S.cmNote = `${c.sysName || c.name} 读取失败：${e.message}`;
        continue;
      }
    }
    out.push({ s: { id, label: c.sysName ? `${c.sysName}（${c.name}）` : c.name, region: c.region }, quotes: hit.quotes });
  }
  S.cm = out;
  S.cmKey = out.map((x) => x.s.id).join(',') + '@' + out.map((x) => customCache.get(x.s.id)?.at).join(',');
  if (out.length === F.custom.length) S.cmNote = `含 ${out.length} 个自定义市场`;
  S.rows = null;
  if (box) render(box);
}
async function regionOrders(region, onProgress) {
  const url = (p) => ctx.esiUrl(`/markets/${region}/orders/?order_type=all&page=${p}`);
  const first = await fetch(url(1));
  if (!first.ok) throw new Error('ESI ' + first.status);
  const pages = Number(first.headers.get('x-pages')) || 1;
  const all = await first.json();
  let done = 1;
  onProgress(done, pages);
  const queue = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const r = await fetch(url(p));
      if (r.ok) all.push(...await r.json());
      onProgress(++done, pages);
    }
  }));
  return all;
}

async function load(force) {
  if (S.loading && !force) return S.loading;
  S.loading = (async () => {
    const res = await fetch(`/api/v1/hubs/arbitrage?server=${ctx.server}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'HTTP ' + res.status);
    return data;
  })();
  try {
    S.data = await S.loading;
    S.error = null;
    S.rows = null;
  } catch (e) {
    S.error = e.message;
  } finally {
    S.loading = null;
  }
}

// 服务端数组 → hub-compare 用的对象
function hubsOf(row, names, id) {
  const out = [];
  row.forEach((h, k) => {
    if (!h) return;
    out.push({ id: S.data.hubs[k], name: names[k], sell: h[0], buy: h[1], sellQty: h[2], sellDepth: h[4], buyDepth: h[5], daily: h[6], avg: h[7], daily7: h[8] ?? null, daily1: h[9] ?? null });
  });
  // 玩家建筑：同星域交易中心的日均成交与均价
  for (const { s, quotes } of [...S.sm, ...S.cm]) {
    const q = quotes.get(id);
    if (!q || (q.sell == null && q.buy == null)) continue;
    const k = S.data.hubs.indexOf(s.region);
    const h = k >= 0 ? row[k] : null;
    out.push({ id: s.id, name: s.label, struct: true, ...q, daily: h?.[6] ?? null, avg: h?.[7] ?? null });
  }
  return out;
}

function compute() {
  if (F.mode === 'demand') return computeDemand();
  if (F.mode === 'consume') return computeConsume();
  const key = JSON.stringify([{ ...F, cat: 0, sort: ROUTE_SORT[F.sort] ? F.sort : 'profit', sdir: 0, size: 0 }, ctx.TF.summary(), S.data?.updated, freight(), S.smKey, S.cmKey]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const names = S.data.hubs.map((id) => ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id);
  const score = ROUTE_SORT[F.sort] || ROUTE_SORT.profit;   // 按表头的利润类列排序时，每个物品也按这一项挑路线
  const fr = freight();
  // 买入 / 卖出选的建筑被取消勾选后按「全部」算
  const places = new Set([...S.data.hubs, ...S.sm.map((x) => x.s.id), ...S.cm.map((x) => x.s.id)]);
  const from = places.has(F.from) ? F.from : 0, to = places.has(F.to) ? F.to : 0;
  const rows = [];
  const excl = new Set(F.excl);
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    if (ctx.isGlobal(id) || excl.has(id)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    let best = null, loose = null;
    const better = (r, b) => !b || score(r) > score(b) || (score(r) === score(b) && r.margin > b.margin);
    for (const r of calcRoutes(hubsOf(row, names, id), F.mode, f, { vol: S.vols[id] || 0, ...fr })) {
      // 买入 / 卖出地点、本地倒卖是范围，始终生效；利润与成交量门槛可以放开看
      if (from && r.a.id !== from) continue;
      if (to && r.b.id !== to) continue;
      if (!F.local && r.local) continue;
      const miss = missOf(r);
      if (!miss) { if (better(r, best)) best = r; } else if (!F.strict && better(r, loose)) { loose = r; loose.miss = miss; }
    }
    if (best) rows.push({ id, cat, r: best });
    else if (loose) rows.push({ id, cat, r: loose, off: true });
  }
  // 符合条件的排前面，不符合的（取消「只看符合条件」后才有）排在后面
  rows.sort((x, y) => (x.off - y.off) || score(y.r) - score(x.r) || y.r.margin - x.r.margin);
  S.rows = rows;
  S.key = key;
  return rows;
}

// 按销量选品：目标交易中心的需求指标 + 最好的进货路线
const hubLabel = (id) => String(ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id);
function targetList() {
  return [...S.data.hubs.map((id) => ({ id, name: hubLabel(id), kind: 'hub', region: id })),
    ...S.cm.map(({ s }) => ({ id: s.id, name: s.label, kind: 'custom', region: s.region }))];
}
// 选中的建筑 / 自定义市场还在读挂单时返回 pending，不要先拿别的市场顶上
function targetOf() {
  const list = targetList();
  const t = list.find((x) => x.id === F.target);
  if (t) return t;
  const c = F.target < 0 && F.custom.find((x) => customId(x) === F.target);
  if (c) return { id: F.target, name: c.sysName ? `${c.sysName}（${c.name}）` : c.name, pending: true };
  return list[0];
}
function computeDemand() {
  const key = JSON.stringify(['demand', { ...F, cat: 0, dsort: 0, sdir: 0, size: 0 }, ctx.TF.summary(), S.data?.updated, freight(), S.smKey, S.cmKey]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const names = S.data.hubs.map((id) => ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id);
  const fr = freight();
  const T = targetOf();
  const ti = T.pending ? -1 : S.data.hubs.indexOf(T.region);   // 成交量来自目标所在星域的交易中心
  const share = Math.max(0.1, Number(F.share) || 10) / 100, days = Math.max(1, Number(F.days) || 3);
  const losses = S.data.losses7 || {};
  const excl = new Set(F.excl);
  const rows = [];
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    const h = row[ti];
    if (!h || ctx.isGlobal(id) || excl.has(id)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    const d30 = h[6], d7 = h[8] ?? null, d1 = h[9] ?? null, avg = h[7];
    const daily = F.win === 1 ? (d1 ?? d7 ?? d30) : F.win === 7 ? (d7 ?? d30) : d30;
    if (!daily || !avg) continue;
    const turnover = daily * avg;
    const trend = d30 && d7 != null ? d7 / d30 : null;
    if (turnover < F.minTurn || (F.rising && !(trend >= RISING))) continue;
    const hubs = hubsOf(row, names, id);
    let tgt = hubs.find((x) => x.id === T.id);
    // 建筑 / 自定义市场里没有这个物品的挂单：当作卖空了
    if (!tgt) { tgt = { id: T.id, name: T.name, struct: true, sell: null, buy: null, sellQty: 0, sellDepth: 0, buyDepth: 0, daily: d30, avg }; hubs.push(tgt); }
    const stock = (tgt.sellQty || 0) / daily;
    // 日成交额、库存天数、只看成交上涨是范围，始终生效
    if (F.maxStock && stock > F.maxStock) continue;
    const soldOut = tgt.sell == null;
    const b = soldOut ? { ...tgt, sell: avg } : tgt;
    const list = hubs.map((x) => (x === tgt ? b : x));
    const plan = daily * share * days;
    const info = { daily, turnover, trend, stock, soldOut, high: b.sell / avg, loss: losses[tid] || 0 };
    let best = null, loose = null;
    for (const mode of ['ss', 'bs']) {
      for (const r of calcRoutes(list, mode, f, { vol: S.vols[id] || 0, ...fr })) {
        if (r.b !== b || (mode === 'ss' && r.local) || (!F.local && r.local)) continue;
        const cap = mode === 'ss' ? r.a.sellDepth : (r.a.daily || 0) * share * days;
        const qty = Math.floor(Math.min(plan, cap));
        const perDay = r.unit > 0 ? r.unit * qty / days : 0;
        const x = { ...r, mode, qty, perDay, total: perDay * days, ...info };
        const miss = r.unit <= 0 ? '亏损' : !qty ? '算不出可做数量' : perDay < F.minDay ? '每天利润低于门槛' : '';
        if (!miss) { if (!best || perDay > best.perDay) best = x; } else if (!F.strict && (!loose || x.unit > loose.unit)) { loose = x; loose.miss = miss; }
      }
    }
    if (best) rows.push({ id, cat, r: best, perDay: best.perDay, ...info });
    else if (loose) rows.push({ id, cat, r: loose, perDay: 0, ...info, off: true });
  }
  rows.sort((x, y) => (x.off - y.off) || y.perDay - x.perDay);
  S.rows = rows;
  S.key = key;
  return rows;
}

// 消耗排行：五大交易中心成交量合计 + 被击毁数
function computeConsume() {
  const key = JSON.stringify(['consume', { ...F, cat: 0, csort: 0, sdir: 0, size: 0 }, S.data?.updated, S.smKey]);
  if (S.rows && S.key === key) return S.rows;
  const losses = S.data.losses7 || {};
  const excl = new Set(F.excl);
  const rows = [];
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    if (ctx.isGlobal(id) || excl.has(id)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    let units = 0, turnover = 0, s7 = 0, s30 = 0, cheap = null, per = [];
    row.forEach((h, k) => {
      if (!h) return;
      const d30 = h[6], d7 = h[8] ?? null, d1 = h[9] ?? null;
      const daily = F.win === 1 ? (d1 ?? d7 ?? d30) : F.win === 7 ? (d7 ?? d30) : d30;
      if (daily && h[7]) { units += daily; turnover += daily * h[7]; per.push([S.data.hubs[k], daily]); }
      if (d30 && d7 != null) { s7 += d7; s30 += d30; }
      if (h[0] != null && (!cheap || h[0] < cheap.price)) cheap = { hub: S.data.hubs[k], price: h[0], qty: h[2] };
    });
    const loss = losses[tid] || 0;
    if (!units && !loss) continue;
    const avg = units ? turnover / units : (cheap?.price || 0);
    const lossIsk = loss / 7 * avg;
    const use = turnover + lossIsk;
    const trend = s30 ? s7 / s30 : null;
    if (turnover < F.minTurn || (F.rising && !(trend >= RISING)) || (F.lossOnly && !loss)) continue;
    // 玩家建筑里的最低卖价
    let st = null;
    for (const { s, quotes } of S.sm) {
      const q = quotes.get(id);
      if (q?.sell != null && (!st || q.sell < st.price)) st = { name: s.label, price: q.sell, qty: q.sellQty };
    }
    rows.push({ id, cat, units, turnover, loss, lossIsk, use, trend, cheap, st, per });
  }
  rows.sort((x, y) => y.use - x.use);
  S.rows = rows;
  S.key = key;
  return rows;
}

function consumeControls() {
  const { esc } = ctx;
  return `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline" title="按哪段时间的日均成交量算。24 小时是最近一个完整交易日（UTC）"><span>成交量</span>${seg('win', [[1, '24 小时'], [7, '近 7 天'], [30, '近 30 天']])}</div>
        <div class="pi-inline"><span>日成交额 ≥</span>${select('minTurn', DEMAND_MIN_TURN)}</div>
      </div>
      <div class="ind-rank-row">
        <label class="pi-inline hr-check" title="近 7 天日均成交比 30 天高 30% 以上"><input type="checkbox" data-hr-rising ${F.rising ? 'checked' : ''}><span>只看成交上涨</span></label>
        ${S.data.losses7 ? `<label class="pi-inline hr-check" title="只看近 7 天在击杀库里被击毁过的舰船与部署物"><input type="checkbox" data-hr-lossonly ${F.lossOnly ? 'checked' : ''}><span>只看被击毁的</span></label>` : ''}
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}`;
}

function consumeRow(x, i) {
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const trend = x.trend == null ? '—' : `<span class="${x.trend >= RISING ? 'up' : x.trend <= 1 / RISING ? 'down' : ''}">${x.trend >= 1 ? '+' : ''}${Math.round((x.trend - 1) * 100)}%</span>`;
  const per = x.per.sort((a, b) => b[1] - a[1]).map(([h, d]) => `${hubLabel(h)} ${formatNumber(Math.round(d))}`).join(' · ');
  const markup = x.st && x.cheap ? x.st.price / x.cheap.price - 1 : null;
  return `<tr data-hr-open="${x.id}" title="打开该物品的交易中心比价">
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}${x.trend >= RISING ? ' <b class="hr-tag up" title="近 7 天日均成交量比 30 天高 30% 以上">成交上涨</b>' : ''}</small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td class="num up" title="${x.lossIsk ? `日成交额 ${formatISK(x.turnover)} + 被击毁折合每天 ${formatISK(x.lossIsk)}` : '日成交额合计'}">${formatISK(x.use)}</td>
      <td class="num pi-hide-sm">${formatISK(x.turnover)}</td>
      <td class="num" title="${esc(per)}">${formatNumber(Math.round(x.units))}</td>
      ${S.data.losses7 ? `<td class="num">${x.loss ? formatNumber(x.loss) : '—'}</td>` : ''}
      <td class="num pi-hide-sm">${trend}</td>
      <td title="${x.cheap ? `卖单 ${formatNumber(x.cheap.qty)} 件` : ''}">${x.cheap ? `${esc(hubLabel(x.cheap.hub))} <span class="hc-sub">${px(x.cheap.price)}</span>` : '—'}</td>
      ${S.sm.length ? `<td title="${x.st ? `${esc(String(x.st.name))} · 卖单 ${formatNumber(x.st.qty)} 件` : '启用的玩家建筑里没有卖单'}">${x.st ? `${px(x.st.price)}${markup != null ? ` <small class="${markup > 0 ? 'up' : 'down'}">${markup > 0 ? '+' : ''}${Math.round(markup * 100)}%</small>` : ''}` : '<span class="text-muted">没有卖单</span>'}</td>` : ''}</tr>`;
}

function demandControls() {
  const { esc } = ctx;
  const T = targetOf();
  return `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>目标市场</span><div class="hr-target"><input type="search" class="pi-input" data-hr-tq value="${esc(S.tOpen ? S.tq : tr(T.name))}" placeholder="${esc(tr(T.name))}" spellcheck="false" autocomplete="off" aria-label="目标市场：搜索交易中心或星域" title="搜索交易中心或星域（玩家建筑不能作为目标市场）">
          <div class="kb-suggest hr-target-pop" data-hr-tpop${S.tOpen ? '' : ' hidden'}>${S.tOpen ? targetPopup() : ''}</div></div></div>
        <div class="pi-inline" title="按哪段时间的日均成交量算。24 小时是最近一个完整交易日（UTC），ESI 只有按天的统计"><span>成交量</span>${seg('win', [[1, '24 小时'], [7, '近 7 天'], [30, '近 30 天']])}</div>
        <label class="pi-inline" title="你能拿下目标市场日成交量的多少"><span>份额</span><input type="number" class="pi-input pi-tax" min="1" max="100" step="1" value="${esc(String(F.share))}" data-hr-num="share"><span>%</span></label>
        <label class="pi-inline" title="一次进货打算卖几天"><span>计划卖</span><input type="number" class="pi-input pi-tax" min="1" max="30" step="1" value="${esc(String(F.days))}" data-hr-num="days"><span>天</span></label>
      </div>
      <div class="ind-rank-row">
        <div class="pi-inline"><span>每天利润 ≥</span>${select('minDay', DEMAND_MIN_DAY)}</div>
        <div class="pi-inline"><span>日成交额 ≥</span>${select('minTurn', DEMAND_MIN_TURN)}</div>
        <div class="pi-inline" title="目标市场现有卖单按日成交量够卖几天"><span>库存天数 ≤</span>${select('maxStock', DEMAND_MAX_STOCK)}</div>
        <label class="pi-inline hr-check" title="近 7 天日均成交比 30 天高 30% 以上"><input type="checkbox" data-hr-rising ${F.rising ? 'checked' : ''}><span>只看成交上涨</span></label>
        <label class="pi-inline hr-check" title="在目标市场本地挂收单收货、再挂卖单卖出"><input type="checkbox" data-hr-local ${F.local ? 'checked' : ''}><span>含本地收单</span></label>
        <label class="pi-inline hr-check" title="取消勾选后，亏损或没达到门槛的物品也列出来（灰色，排在后面）"><input type="checkbox" data-hr-strict ${F.strict ? 'checked' : ''}><span>只看符合条件的路线</span></label>
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}`;
}

// 目标市场搜索的候选（英文界面下中英文名都能搜）
const tr = (s) => window.I18N?.t?.(String(s)) ?? String(s);
function targetPopup() {
  const { esc } = ctx;
  const k = S.tq.trim().toLowerCase();
  const hit = (n) => !k || String(n).toLowerCase().includes(k) || tr(n).toLowerCase().includes(k);
  const cur = targetList();
  const T = targetOf();
  const groups = [];
  const add = (title, items) => { if (items.length) groups.push([title, items]); };
  add('交易中心', cur.filter((t) => t.kind === 'hub' && hit(t.name)));
  add('自定义市场', cur.filter((t) => t.kind === 'custom' && hit(t.name)));
  if (k && S.regionNames) {
    const regs = S.regionNames.filter((r) => hit(r.name) && !F.custom.some((c) => c.region === r.id && !c.system)).slice(0, 8);
    add('星域（加为自定义市场）', regs.map((r) => ({ region: r.id, name: r.name, sub: F.custom.length >= CUSTOM_MAX ? `自定义市场已满 ${CUSTOM_MAX} 个` : S.data.hubs.includes(r.id) ? '' : '没有成交量数据' })));
  }
  const html = groups.map(([title, items]) => `<div class="kb-suggest-group">${title}</div>${items.map((o) => `<button type="button" class="kb-suggest-item${o.id === T.id ? ' active' : ''}" ${o.region && !o.kind ? `data-hr-tregion="${o.region}"` : `data-hr-target="${o.id}"`}><span>${esc(String(o.name))}</span>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</button>`).join('')}`).join('');
  return (html || '<div class="kb-suggest-group">没有匹配的市场</div>') + '<div class="kb-suggest-group hr-target-tip">玩家建筑市场不能作为目标市场</div>';
}
function fillTargetPop(box) {
  const pop = box.querySelector('[data-hr-tpop]');
  if (!pop) return;
  pop.hidden = !S.tOpen;
  pop.innerHTML = S.tOpen ? targetPopup() : '';
}
function closeTarget(box) {
  if (!S.tOpen) return;
  S.tOpen = false; S.tq = '';
  const inp = box.querySelector('[data-hr-tq]');
  if (inp) inp.value = tr(targetOf().name);
  fillTargetPop(box);
}
function pickTarget(box, id) {
  F.target = id;
  S.tOpen = false; S.tq = '';
  save(); render(box);
}
function pickTargetRegion(box, region) {
  if (F.custom.length >= CUSTOM_MAX) { ctx.showToast(`自定义市场最多 ${CUSTOM_MAX} 个，先在「自定义市场」里移除一个`, 'error'); return; }
  const r = S.regionNames.find((x) => x.id === region);
  const c = { region, name: r?.name || String(region), system: 0, sysName: '' };
  F.custom = [...F.custom, c];
  pickTarget(box, customId(c));
  loadCustom(box);
}

function demandRow(x, i) {
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  const r = x.r;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const cls = r.unit > 0 ? 'up' : 'down';
  const tags = [x.soldOut ? ['无卖单', '目标市场现在没人挂卖单，卖价按 30 天成交均价估算', 'hot'] : null,
    !x.soldOut && x.stock < TIGHT ? ['库存少', `目标市场的卖单按日成交量只够卖 ${x.stock.toFixed(1)} 天`, 'hot'] : null,
    x.trend >= RISING ? ['成交上涨', `近 7 天日均成交量是 30 天的 ${x.trend.toFixed(2)} 倍`, 'up'] : null,
    !x.soldOut && x.high >= HIGH ? ['卖价偏高', `现在的最低卖价比 30 天成交均价高 ${Math.round((x.high - 1) * 100)}%`, 'warn'] : null].filter(Boolean);
  const how = r.mode === 'bs' ? (r.local ? '本地挂收单' : `${esc(String(r.a.name))} 挂收单`) : `${esc(String(r.a.name))} 直接买`;
  const trend = x.trend == null ? '—' : `<span class="${x.trend >= RISING ? 'up' : x.trend <= 1 / RISING ? 'down' : ''}">${x.trend >= 1 ? '+' : ''}${Math.round((x.trend - 1) * 100)}%</span>`;
  return `<tr data-hr-open="${x.id}" data-hr-mode-open="${r.mode}"${x.off ? ` class="hr-off" title="不符合条件：${esc(r.miss)} · 点击打开该物品的交易中心比价"` : ' title="打开该物品的交易中心比价"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}${tags.map(([t, tip, c]) => ` <b class="hr-tag ${c}" title="${esc(tip)}">${t}</b>`).join('')}</small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td title="进货价 ${px(r.buyAt)} · 卖出价 ${px(r.sellAt)}${x.soldOut ? '（估）' : ''}">${how}</td>
      <td class="num ${r.perDay ? 'up' : ''}">${r.perDay ? formatISK(r.perDay) : '—'}</td>
      <td class="num ${cls}">${(r.unit > 0 ? '+' : '') + px(r.unit)}</td>
      <td class="num">${r.qty ? formatNumber(r.qty) : '—'}</td>
      <td class="num" title="日均成交 ${formatNumber(Math.round(x.daily))} 件">${formatISK(x.turnover)}</td>
      <td class="num pi-hide-sm">${trend}</td>
      <td class="num pi-hide-sm">${x.soldOut ? '<span class="down">0</span>' : x.stock >= 100 ? '100+' : x.stock.toFixed(1)}</td>
      ${S.data.losses7 ? `<td class="num pi-hide-sm">${x.loss ? formatNumber(x.loss) : '—'}</td>` : ''}</tr>`;
}

// 路线不符合哪个条件（符合时返回空串）
function missOf(r) {
  if (r.unit <= 0) return '亏损';
  if (!r.qty) return '算不出可做数量';
  if (r.total < F.minProfit) return '预计利润低于门槛';
  if (F.minDaily && Math.max(r.a.daily || 0, r.b.daily || 0) < F.minDaily) return '日均成交低于门槛';
  return '';
}

const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-hr-${k}="${v}" class="${String(F[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const select = (k, items) => `<select class="pi-input" data-hr-sel="${k}">${items.map(([v, l]) => `<option value="${v}"${String(F[k]) === String(v) ? ' selected' : ''}>${ctx.esc(String(l))}</option>`).join('')}</select>`;

function html(all0) {
  const { esc, formatISK, formatPrice, formatNumber, TF } = ctx;
  const all = F.cat ? all0.filter((x) => x.cat.id === F.cat) : all0;
  const q = S.q.trim().toLowerCase();
  const list0 = q ? all.filter((x) => ctx.typeName(x.id).toLowerCase().includes(q) || String(x.id) === q) : all;
  const list = sortRows(list0);
  // 筛选 / 排序 / 模式变了回到第 1 页（排除物品不算，免得在后面的页上排除一个就跳回去）
  const pk = JSON.stringify([{ ...F, excl: 0 }, q]);
  if (S.pageKey !== pk) { S.pageKey = pk; S.page = 1; }
  const size = pageSize(), pages = Math.max(1, Math.ceil(list.length / size));
  S.page = Math.min(Math.max(1, S.page), pages);
  const off = (S.page - 1) * size;
  const top = list.slice(off, off + size);
  const hubOpts = [[0, '全部'], ...S.data.hubs.map((id) => [id, ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id]),
    ...S.sm.map(({ s }) => [s.id, s.label]), ...S.cm.map(({ s }) => [s.id, s.label])];
  const catName = F.cat ? catNameOf(F.cat) : '';
  const noVol = !all0.length && F.mode !== 'sb' && Object.values(S.data.types).every((r) => r.every((h) => !h || h[6] == null));
  const name = (h) => esc(String(h.name));
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);   // 大额用 M / B，表格放得下
  const ok = list.filter((x) => !x.off).length;
  const sign = (v) => (v > 0 ? '+' : '') + px(v);
  const D = F.mode === 'demand', C = F.mode === 'consume';
  const rows = C ? top.map((x, i) => consumeRow(x, off + i)).join('') : D ? top.map((x, i) => demandRow(x, off + i)).join('') : top.map((x, i0) => {
    const i = off + i0;
    const r = x.r;
    const cls = r.unit > 0 ? 'up' : 'down';
    return `<tr data-hr-open="${x.id}"${x.off ? ` class="hr-off" title="不符合条件：${esc(r.miss)} · 点击打开该物品的交易中心比价"` : ' title="打开该物品的交易中心比价"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}</small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td>${r.local ? `${name(r.a)} <small class="hc-sub">本地</small>` : `${name(r.a)} <span class="hc-arrow">→</span> ${name(r.b)}`}</td>
      <td class="num pi-hide-sm">${px(r.buyAt)}</td>
      <td class="num pi-hide-sm">${px(r.sellAt)}</td>
      <td class="num ${cls}">${sign(r.unit)}</td>
      <td class="num ${cls}">${(r.margin * 100).toFixed(1)}%</td>
      <td class="num pi-hide-sm" title="${r.vol ? formatNumber(r.vol) + ' m³ / 件' : '体积未知'}">${r.perM3 != null ? formatISK(r.perM3) : '—'}</td>
      <td class="num">${r.qty ? formatNumber(r.qty) : '—'}</td>
      <td class="num pi-hide-sm">${r.qty ? formatISK(r.cost * r.qty) : '—'}</td>
      <td class="num ${r.total ? 'up' : ''}">${r.total ? formatISK(r.total) : '—'}</td></tr>`;
  }).join('');
  return `<div class="hr-wrap">
    <div class="pi-card ind-rank-filters">
      <div class="hc-head"><h3>交易中心倒卖排行${catName ? ` <small class="hr-cat-tag">${esc(catName)}<button type="button" class="ka-close" data-hr-cat="0" title="看全部分类" aria-label="看全部分类">×</button></small>` : ''}</h3><span class="toolbar-spacer"></span>
        <button class="btn btn-ghost btn-sm hr-filter-btn" data-hr-side title="按分类筛选">分类</button>
        <button class="btn btn-ghost btn-sm" data-hr-fees title="调整技能与税费">${esc(TF.summary())}</button>
        ${ctx.structs ? `<button class="btn btn-ghost btn-sm" data-hr-structs title="把你有权限的玩家建筑市场加入排行（需绑定 ESI）">玩家建筑市场${ctx.structs.count() ? `（${ctx.structs.count()}）` : ''}</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-hr-custom title="任选星域（可限定星系）的 NPC 市场加入排行">自定义市场${F.custom.length ? `（${F.custom.length}）` : ''}</button>
        <button class="btn btn-ghost btn-sm" data-hr-reload>刷新</button></div>
      ${S.showCustom ? `<div class="ind-rank-row hr-custom">
        <input class="pi-input" data-hr-cregion list="hrRegionList" placeholder="星域" autocomplete="off" aria-label="星域">
        <datalist id="hrRegionList">${(S.regionNames || []).map((r) => `<option value="${esc(r.name)}"></option>`).join('')}</datalist>
        <input class="pi-input" data-hr-csystem placeholder="星系（可不填 = 整个星域）" autocomplete="off" aria-label="星系">
        <button type="button" class="btn btn-primary btn-sm" data-hr-cadd${F.custom.length >= CUSTOM_MAX ? ' disabled' : ''}>添加</button>
        ${F.custom.map((c) => `<span class="ka-chip">${esc(c.sysName ? c.sysName + ' · ' + c.name : c.name)}<button type="button" class="ka-close" data-hr-cdel="${customId(c)}" aria-label="移除">×</button></span>`).join('')}
        <span class="pi-note">最多 ${CUSTOM_MAX} 个；浏览器直接读该星域全部挂单，大星域要等一会儿。星域里没有交易中心时没有成交量数据，只能算「直接成交」</span></div>` : ''}
      <div class="ind-rank-row">${seg('mode', [...MODES, ['demand', '按销量选品'], ['consume', '消耗排行']])}</div>
      ${C ? consumeControls() : D ? demandControls() : `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>买入</span>${select('from', hubOpts)}</div>
        <div class="pi-inline"><span>卖出</span>${select('to', hubOpts)}</div>
        <label class="pi-inline hr-check"><input type="checkbox" data-hr-local ${F.local ? 'checked' : ''}><span>含本地倒卖</span></label>
        <label class="pi-inline hr-check" title="取消勾选后，亏损、算不出可做数量或没达到利润 / 成交量门槛的物品也列出来（灰色，排在后面）"><input type="checkbox" data-hr-strict ${F.strict ? 'checked' : ''}><span>只看符合条件的路线</span></label>
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}
      <div class="ind-rank-row">
        <div class="pi-inline"><span>预计利润 ≥</span>${select('minProfit', MIN_PROFIT)}</div>
        <div class="pi-inline"><span>日均成交 ≥</span>${select('minDaily', MIN_DAILY)}</div>
      </div>`}
      ${C ? '' : `<div class="ind-rank-row">${freightHtml('hr')}</div>`}
      <p class="pi-note" title="${C ? `日成交量是五大交易中心所在星域的统计加起来（含周边玩家建筑）；消耗额 = 日成交额合计 + 近 7 天日均被击毁数 × 均价（只有宁静服有击杀数据）。建筑卖价是已启用的玩家建筑市场里的最低卖价，百分比是比最便宜的交易中心贵多少。` : D ? `目标市场的成交量是整个星域的统计（含周边玩家建筑；自定义市场借用同星域交易中心的数据），库存天数用目标市场自己的卖单；建议数量 = 日均成交 × 份额 × 计划天数，不超过进货地卖单深度（挂收单按进货地日均成交 × 份额）。挂单价偏离 30 天成交均价太多的不算。` : '可做数量：直接成交按最优价 5% 以内的订单深度，挂单按星域日均成交 10%，两端取小。日均成交是整个星域的 30 天平均；挂单价偏离 30 天成交均价太多（收单低于 60%、卖单高于 140%）的不算。'}">
        ${ok} 个物品符合条件${list.length > ok ? `，另有 ${list.length - ok} 个不符合` : ''}${C ? '' : ` · ${freight().m3 || freight().collat ? '跨中心路线已扣运费' : '未计运费'}`} · 行情 ${S.data.updated ? new Date(S.data.updated).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'} 汇总${S.data.progress ? ` · <span title="读完后自动更新">服务器${esc(S.data.progress)}</span>` : ''}${S.smNote ? ` · <span data-hr-smnote>${esc(S.smNote)}</span>` : ''}${S.cmNote ? ` · <span data-hr-cmnote>${esc(S.cmNote)}</span>` : ''}</p>
    </div>
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table hr-table"><thead><tr>
      ${C ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('use', '消耗额', 'num', '日成交额合计 + 被击毁折合每天的价值')}${th('turn', '日成交额', 'num pi-hide-sm')}${th('units', '日成交量', 'num', '五大交易中心日均成交量合计，悬停看各中心')}${S.data.losses7 ? th('loss', '近 7 天被击毁', 'num', '本站击杀库近 7 天被击毁的数量（舰船与部署物）') : ''}${th('trend', '趋势', 'num pi-hide-sm', '近 7 天日均成交比 30 天')}${th('price', '最便宜的交易中心')}${S.sm.length ? th('markup', '建筑卖价', '', '已启用的玩家建筑市场里的最低卖价，百分比是比最便宜的交易中心贵多少') : ''}`
    : D ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '进货')}${th('day', '每天利润', 'num')}${th('unit', '每件利润', 'num')}${th('qty', '建议数量', 'num')}${th('turn', '日成交额', 'num', '日均成交量 × 成交均价')}${th('trend', '趋势', 'num pi-hide-sm', '近 7 天日均成交比 30 天')}${th('stock', '库存天数', 'num pi-hide-sm', '目标市场卖单库存够卖几天')}${S.data.losses7 ? th('loss', '近 7 天被击毁', 'num pi-hide-sm', '本站击杀库近 7 天被击毁的数量（舰船与部署物）') : ''}`
    : `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '路线')}${th('buy', '买入价', 'num pi-hide-sm')}${th('sell', '卖出价', 'num pi-hide-sm')}${th('unit', '每件利润', 'num', '同时按这一项为每个物品挑路线')}${th('margin', '利润率', 'num', '同时按这一项为每个物品挑路线')}${th('m3', '每立方', 'num pi-hide-sm', '同时按这一项为每个物品挑路线')}${th('qty', '可做数量', 'num')}${th('cost', '投入', 'num pi-hide-sm')}${th('profit', '预计利润', 'num', '同时按这一项为每个物品挑路线')}`}
    </tr></thead><tbody>${rows || `<tr><td colspan="11" class="text-muted">${noVol || ((D || C) && !hasVol()) ? '成交量还在读取中，挂单方式暂时算不出可做数量' : C ? '没有符合条件的物品' : D ? demandEmpty() : '没有符合条件的路线'}</td></tr>`}</tbody></table></div>
      ${list.length ? pagerHtml(S.page, pages, list.length, off + 1, off + top.length) : ''}</div>
  </div>`;
}

function demandEmpty() {
  const T = targetOf();
  if (T.pending) return `正在读取 ${ctx.esc(T.name)} 的挂单…`;
  if (!S.data.hubs.includes(T.region)) return `${ctx.esc(T.name)} 所在星域没有交易中心，没有成交量数据，按销量选品算不了`;
  return '没有符合条件的物品';
}
const hasVol = () => Object.values(S.data.types).some((r) => r.some((h) => h && h[6] != null));

function catNameOf(id) {
  for (const t of Object.keys(S.data.types)) { const c = ctx.category(Number(t)); if (c?.id === id) return c.name; }
  return '';
}

// 侧栏：分类列表（符合条件的物品数）
function renderSide(all) {
  const side = S.side;
  if (!side) return;
  const { esc } = ctx;
  const counts = new Map();
  for (const x of all) if (!x.off) { const c = counts.get(x.cat.id) || { name: x.cat.name, n: 0 }; c.n++; counts.set(x.cat.id, c); }
  if (F.cat && !counts.has(F.cat)) counts.set(F.cat, { name: catNameOf(F.cat), n: 0 });
  const total = all.filter((x) => !x.off).length;
  const cats = [...counts].sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name, 'zh'));
  const btn = (id, name, n) => `<button type="button" class="ind-side-item${F.cat === id ? ' active' : ''}" data-hr-cat="${id}"><span>${esc(String(name))}</span><small>${n}</small></button>`;
  const top = side.scrollTop;
  side.innerHTML = `<div class="ind-side-section"><h4>分类 <small>符合条件的物品数</small></h4>${btn(0, '全部分类', total)}${cats.map(([id, c]) => btn(id, c.name, c.n)).join('')}</div>`;
  side.scrollTop = top;
}

function render(box) {
  if (!box.isConnected || box.hidden) return;
  clearTimeout(S.timer);
  if (S.error && !S.data) {
    box.innerHTML = `<div class="pi-card"><p class="text-muted">读取失败：${ctx.esc(S.error)}</p><button class="btn btn-ghost btn-sm" data-hr-reload>重试</button></div>`;
    return;
  }
  if (!S.data || S.data.loading) {
    box.innerHTML = `<div class="pi-card"><h3>交易中心倒卖排行</h3><div class="pi-loading">服务器正在汇总五个交易中心的全部挂单${S.data?.progress ? '：' + ctx.esc(S.data.progress) : '…'}</div><p class="pi-note">首次大约需要 1–3 分钟，之后每 30 分钟自动刷新</p></div>`;
    S.timer = setTimeout(async () => { await load(true); render(box); }, S.data ? POLL : 0);
    return;
  }
  if (window.__imeComposing && box.contains(document.activeElement)) { setTimeout(() => render(box), 500); return; }   // 正在用输入法打字：先不重画，免得打断组字
  const focus = document.activeElement?.matches?.('[data-hr-q]') ? document.activeElement.selectionStart : null;
  const tFocus = document.activeElement?.matches?.('[data-hr-tq]') ? document.activeElement.selectionStart : null;
  const typed = ['[data-hr-cregion]', '[data-hr-csystem]'].map((sel) => box.querySelector(sel)?.value || '');
  const all = compute();
  box.innerHTML = html(all);
  renderSide(all);
  ['[data-hr-cregion]', '[data-hr-csystem]'].forEach((sel, i) => { const el = box.querySelector(sel); if (el && typed[i]) el.value = typed[i]; });
  if (focus != null) { const inp = box.querySelector('[data-hr-q]'); inp.focus(); inp.setSelectionRange(focus, focus); }
  if (tFocus != null && S.tOpen) { const inp = box.querySelector('[data-hr-tq]'); if (inp) { inp.focus(); inp.setSelectionRange(tFocus, tFocus); } }
  if (S.data.progress) poll(box);
}

// 结果有变化（成交量又读了一批、或读完）才重画，否则只更新进度文字
function poll(box) {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    const at = S.data.updated;
    await load(true);
    if (!box.isConnected || box.hidden) return;
    if (S.data?.updated !== at || !S.data?.progress) { render(box); return; }
    const note = box.querySelector('.pi-note span');
    if (note) note.textContent = '服务器' + S.data.progress;
    poll(box);
  }, POLL_VOLUME);
}

export async function showHubRank(box, side) {
  if (!box.dataset.bound) bind(box);
  S.box = box;
  S.side = side || null;
  if (side && !side.dataset.bound) {
    side.dataset.bound = '1';
    side.addEventListener('click', (e) => { const c = e.target.closest('[data-hr-cat]'); if (c) pickCat(Number(c.dataset.hrCat)); });
  }
  S.vols = await loadVolumes();
  if (!S.data || S.data.loading) await load();
  render(box);
  // 建筑市场缓存 5 分钟，过期或勾选变了再读
  if (ctx.structs?.count() && (!S.smKey || Date.now() - Number(S.smKey.split('@')[1]) > 5 * 60e3)) loadStructs(box);
  if (F.custom.length && (!S.cm.length || S.cm.some((x) => Date.now() - (customCache.get(x.s.id)?.at || 0) > CUSTOM_TTL))) loadCustom(box);
}

async function addCustom(box) {
  const rIn = box.querySelector('[data-hr-cregion]'), sIn = box.querySelector('[data-hr-csystem]');
  const list = S.regionNames || await ctx.regionList();
  const key = rIn.value.trim().toLowerCase();
  const region = list.find((r) => r.name.toLowerCase() === key) || (key && list.find((r) => r.name.toLowerCase().includes(key)));
  if (!region) { ctx.showToast('没有找到这个星域', 'error'); return; }
  let system = 0, sysName = '';
  if (sIn.value.trim()) {
    const sys = await ctx.findSystem(sIn.value.trim());
    if (!sys) { ctx.showToast('没有找到这个星系', 'error'); return; }
    if (sys.region !== region.id) { ctx.showToast(`${sys.name} 不在 ${region.name}`, 'error'); return; }
    system = sys.id; sysName = sys.name;
  }
  const c = { region: region.id, name: region.name, system, sysName };
  if (F.custom.some((x) => customId(x) === customId(c))) { ctx.showToast('已经添加过了', 'error'); return; }
  F.custom = [...F.custom, c].slice(0, CUSTOM_MAX);
  save();
  render(box);
  loadCustom(box);
}

// 技能或税费改动后重算
export function refreshHubRank(box) {
  if (S.data && !S.data.loading && box && !box.hidden) render(box);
}

function pickCat(id) {
  F.cat = id;
  save();
  render(S.box);
  ctx.closeSide?.();
  S.box.closest('.main-content')?.scrollTo({ top: 0 });
}

// 点表头：换列默认方向，同一列再点换方向
function sortBy(box, k) {
  const { m, k: cur, dir } = sortState();
  const next = cur === k ? (dir === 'asc' ? 'desc' : 'asc') : (ASC.has(k) ? 'asc' : 'desc');
  F[SORT_KEY[m]] = k;
  F.sdir = { ...F.sdir, [m]: { ...(F.sdir?.[m] || {}), [k]: next } };
  save(); render(box);
  box.querySelector(`th[data-hr-col="${k}"]`)?.focus({ preventScroll: true });
}
function goPage(box, n) {
  S.page = n;
  render(box);
  const wrap = box.querySelector('.pi-table-wrap');
  if (wrap) { wrap.scrollTop = 0; const top = wrap.closest('.pi-card').getBoundingClientRect().top; if (top < 0) wrap.closest('.pi-card').scrollIntoView({ block: 'start' }); }
}

function bind(box) {
  box.dataset.bound = '1';
  // 目标市场搜索：点外面或按 Esc 收起；候选按钮用 mousedown 防止输入框先失焦
  document.addEventListener('click', (e) => { if (S.tOpen && !e.target.closest('.hr-target')) closeTarget(box); });
  box.addEventListener('mousedown', (e) => { if (e.target.closest('[data-hr-tpop]')) e.preventDefault(); });
  box.addEventListener('focusin', (e) => {
    if (!e.target.matches('[data-hr-tq]') || S.tOpen) return;
    S.tOpen = true; S.tq = '';
    e.target.value = '';
    fillTargetPop(box);
    if (!S.regionNames) ctx.regionList().then((l) => { S.regionNames = l; if (S.tOpen) fillTargetPop(box); }).catch(() => {});
  });
  box.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-hr-col]')) { e.preventDefault(); sortBy(box, e.target.dataset.hrCol); return; }
    if (!e.target.matches('[data-hr-tq]')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTarget(box); e.target.blur(); }
    if (e.key === 'Enter') { e.preventDefault(); box.querySelector('[data-hr-tpop] [data-hr-target],[data-hr-tpop] [data-hr-tregion]')?.click(); }
  });
  box.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-hr-target]');
    if (tg) { pickTarget(box, Number(tg.dataset.hrTarget)); return; }
    const tr = e.target.closest('[data-hr-tregion]');
    if (tr) { pickTargetRegion(box, Number(tr.dataset.hrTregion)); return; }
    const col = e.target.closest('[data-hr-col]');
    if (col) { sortBy(box, col.dataset.hrCol); return; }
    const pg = e.target.closest('[data-hr-page]');
    if (pg && !pg.disabled) { goPage(box, Number(pg.dataset.hrPage)); return; }
    const cat = e.target.closest('[data-hr-cat]');
    if (cat) { pickCat(Number(cat.dataset.hrCat)); return; }
    if (e.target.closest('[data-hr-side]')) { ctx.openSide?.(); return; }
    const b = e.target.closest('[data-hr-mode],[data-hr-sort],[data-hr-win],[data-hr-dsort],[data-hr-csort]');
    if (b) {
      if (b.dataset.hrMode) F.mode = b.dataset.hrMode;
      if (b.dataset.hrSort) F.sort = b.dataset.hrSort;
      if (b.dataset.hrWin) F.win = Number(b.dataset.hrWin);
      if (b.dataset.hrDsort) F.dsort = b.dataset.hrDsort;
      if (b.dataset.hrCsort) F.csort = b.dataset.hrCsort;
      save(); render(box); return;
    }
    if (e.target.closest('[data-hr-fees]')) { ctx.TF.openFeeDialog(); return; }
    if (e.target.closest('[data-hr-structs]')) { closeTarget(box); ctx.structs.open(); return; }
    if (e.target.closest('[data-hr-reload]')) { load(true).then(() => render(box)); return; }
    const hide = e.target.closest('[data-hr-hide]');
    if (hide) { F.excl = [...new Set([...F.excl, Number(hide.dataset.hrHide)])]; save(); render(box); return; }
    const unhide = e.target.closest('[data-hr-unhide]');
    if (unhide) { F.excl = F.excl.filter((x) => x !== Number(unhide.dataset.hrUnhide)); save(); render(box); return; }
    if (e.target.closest('[data-hr-unhide-all]')) { F.excl = []; S.showExcl = false; save(); render(box); return; }
    if (e.target.closest('[data-hr-excl-toggle]')) { S.showExcl = !S.showExcl; render(box); return; }
    if (e.target.closest('[data-hr-custom]')) {
      S.showCustom = !S.showCustom;
      render(box);
      if (S.showCustom && !S.regionNames) ctx.regionList().then((l) => { S.regionNames = l; render(box); }).catch(() => {});
      return;
    }
    if (e.target.closest('[data-hr-cadd]')) { addCustom(box); return; }
    const cdel = e.target.closest('[data-hr-cdel]');
    if (cdel) {
      const id = Number(cdel.dataset.hrCdel);
      F.custom = F.custom.filter((c) => customId(c) !== id);
      if (F.from === id) F.from = 0;
      if (F.to === id) F.to = 0;
      if (F.target === id) F.target = 0;
      save();
      loadCustom(box).then(() => render(box));
      return;
    }
    const row = e.target.closest('[data-hr-open]');
    if (row) { const m = row.dataset.hrModeOpen || F.mode; if (MODES.some(([k]) => k === m)) setHubMode(m); ctx.openItem(Number(row.dataset.hrOpen)); }
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-hr-sel]');
    if (sel) { F[sel.dataset.hrSel] = Number(sel.value); save(); render(box); return; }
    if (e.target.matches('[data-hr-local]')) { F.local = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-strict]')) { F.strict = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-rising]')) { F.rising = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-size]')) { F.size = Number(e.target.value); save(); render(box); return; }
    if (e.target.matches('[data-hr-jump]')) { goPage(box, Number(e.target.value) || 1); return; }
    if (e.target.matches('[data-hr-lossonly]')) { F.lossOnly = e.target.checked; save(); render(box); return; }
    const num = e.target.closest('[data-hr-num]');
    if (num) {
      const k = num.dataset.hrNum;
      F[k] = Math.min(k === 'share' ? 100 : 30, Math.max(1, Math.round(Number(num.value) || (k === 'share' ? 10 : 3))));
      save(); render(box); return;
    }
    if (e.target.matches('[data-hr-m3],[data-hr-collat]')) { setFreight(box.querySelector('[data-hr-m3]').value, box.querySelector('[data-hr-collat]').value); render(box); }
  });
  let t = 0;
  box.addEventListener('input', (e) => {
    if (e.target.matches('[data-hr-tq]')) { S.tOpen = true; S.tq = e.target.value; fillTargetPop(box); return; }
    if (!e.target.matches('[data-hr-q]')) return;
    S.q = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => render(box), 200);
  });
}
