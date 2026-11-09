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
// 改单推荐（mode = relist）：同一个交易中心挂收单收货、挂卖单出货（站内倒卖，要经常改单抢位置），只推荐做什么，不推荐改成多少钱。
//   ESI 每天只有成交均价，不分收单 / 卖单成交：服务器按每天「均价 = f × 最高价 + (1 − f) × 最低价」解出卖单侧成交占比 f（近 30 天按成交量加权，
//   字段 sshare）；没有时按当前收单价 / 卖单价与 30 天均价近似（标「估」）。收单每天能收到约 (1 − f) × 日成交，卖单能卖出约 f × 日成交，
//   每天可做 = 两边取小 × 份额。每件利润 = 卖价扣销售税与中介费 − 收价加中介费 − 改单费（每天改 N 次，两张单各按 (1 − 改单折扣) × 中介费率 × 价格摊到每件）。
//   偏卖方（f ≥ 65%，收单难收到货）/ 偏买方（f ≤ 35%，卖单难卖）/ 均衡。挂单价离 30 天均价太远（收单 < 60%、卖单 > 140%）的不算。
//   竞争：服务器汇总的 scomp / bcomp——最优价 5% 以内、近 24 小时发布或改过价的卖单 / 收单张数，两边相加分 低（≤ 3）/ 中（≤ 8）/ 高；可按竞争筛掉。
// 化矿排行（mode = reproc）：在交易中心直接买（卖单）或挂收单收进物品，化矿后把产物在同一个交易中心卖给收单或挂卖单。
//   化矿率与再处理税用估价页的化矿设置（trade-fees.js 的 reprocYield），产出按期望值算（不按批次取整）；
//   每天可做 = 日成交 × 份额（直接买再受最优价 5% 以内卖单深度限制），按化矿批量向下取整。产物在该中心没有对应价格的物品不算。
// 倒卖方式：买入（卖单收 / 收单收 / 中位价收 / 最低价收 / 最高价收）和卖出（收单出 / 卖单出 / 中位价出 / 最低价出 / 最高价出）自由组合，
//   F.mode 是两个字母（hub-compare.js 的 MODES），F.rmode 记住上次的组合（切到按销量选品 / 消耗排行再切回来还是它）；
//   成交价取近 F.med 天（1 = 24 小时）：服务器汇总的 med / low / high{1,7,14,30}，数据量大，用到时才带 hist=1 重新取一次（之后一直带）。
//   按成交价挂单而现价偏离 20% 以上的路线标「现价偏离」（hub-compare.js 的 devTip）。
// 排序：点表头排序（再点一次换方向），普通倒卖按预计利润 / 利润率 / 每件利润 / 每立方利润排序时，每个物品也按这一项挑最好的路线。
// 分页：全部结果都能看，每页 50 / 100 / 200 / 500 条。
// 预加载（prefetchHubRank，用过倒卖排行的浏览器在页面空闲时调用）：先取服务器汇总、包装体积、勾选建筑与自定义市场的挂单，
//   打开倒卖排行时直接出结果；建筑订单后台刷新完（structs.onData）悄悄换上新数据，不显示「正在读取」。
// 按当前舰船规划（planHaul）：读角色正在开的船（装配页按装配与技能算出货舱容量），在当前筛选出来的路线里装满一船：
//   见下方 planHaul 的说明；没绑定 ESI 时可以手填货舱容量。
// 分类：打开倒卖排行时市场中心侧栏的物品目录换成分类列表（#arbSide），显示每个分类符合条件的物品数。
import { calcRoutes, ROUTE_SORT, MODES, MED_DAYS, usesHist, devTip, oddTip, routeTags, daysLabel, setHubMode, modePicker, modeClick, loadVolumes, freight, setFreight, freightHtml } from './hub-compare.js?v=v15';
import { exportCsv, exportBtnHtml } from './csv-export.js?v=2';

let ctx = null;   // server, regions, esc, formatISK, formatPrice, formatNumber, TF, typeName, category, isGlobal, iconUrl, openItemPop, openItem
const PAGE_SIZES = [50, 100, 200, 500];
const POLL = 4000;
const POLL_VOLUME = 20000;   // 服务器还在读成交量时，隔一会儿取一次新结果
const MIN_PROFIT = [[0, '不限'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿']];
const MIN_DAILY = [[0, '不限'], [10, '10'], [100, '100'], [1000, '1000']];
// 买入 / 卖出选了玩家建筑且那一侧挂单：建筑没有成交记录，算不出可做数量和预计利润，改按每件利润 + 直接成交深度筛
const MIN_QTY = [[0, '不限'], [10, '10'], [100, '100'], [1000, '1000'], [1e4, '1 万']];
const MIN_UNIT = [[0, '不限'], [1e4, '1 万'], [1e5, '10 万'], [1e6, '100 万'], [1e7, '1000 万']];
const MIN_M3 = [[0, '不限'], [1e3, '1000'], [1e4, '1 万'], [1e5, '10 万'], [1e6, '100 万']];
const DEMAND_MIN_DAY = [[0, '不限'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿']];
const DEMAND_MIN_TURN = [[0, '不限'], [1e7, '1000 万'], [1e8, '1 亿'], [1e9, '10 亿']];
const DEMAND_MAX_STOCK = [[0, '不限'], [1, '1 天'], [3, '3 天'], [7, '7 天']];
// 表头排序：每种模式各列的取值（null 永远排最后），ASC 里的列第一次点按升序
const COLS = {
  route: { name: null, buy: (x) => x.r.buyAt, sell: (x) => x.r.sellAt, unit: (x) => x.r.unit, margin: (x) => x.r.margin, m3: (x) => x.r.perM3, qty: (x) => x.r.qty || null, cost: (x) => (x.r.qty ? x.r.cost * x.r.qty : null), profit: (x) => x.r.total },
  demand: { name: null, day: (x) => x.perDay, unit: (x) => x.r.unit, qty: (x) => x.r.qty || null, turn: (x) => x.turnover, trend: (x) => x.trend, stock: (x) => (x.soldOut ? 0 : x.stock), loss: (x) => x.loss },
  reproc: { name: null, day: (x) => x.perDay, unit: (x) => x.unit, margin: (x) => x.margin, qty: (x) => x.qty, buy: (x) => x.cost, value: (x) => x.value, turn: (x) => x.turnover },
  relist: { name: null, day: (x) => x.perDay, unit: (x) => x.unit, margin: (x) => x.margin, qty: (x) => x.qty, bias: (x) => x.f, comp: (x) => x.comp ?? -1, turn: (x) => x.turnover },
  consume: { name: null, use: (x) => x.use, turn: (x) => x.turnover, units: (x) => x.units, loss: (x) => x.loss, trend: (x) => x.trend, price: (x) => x.cheap?.price ?? null, markup: (x) => (x.st && x.cheap ? x.st.price / x.cheap.price - 1 : null) }
};
const SORT_KEY = { route: 'sort', demand: 'dsort', consume: 'csort', relist: 'rsort', reproc: 'psort' };
const ASC = new Set(['name', 'buy', 'stock', 'price', 'markup']);
const KINDS = ['demand', 'consume', 'relist', 'reproc'];
const modeKind = () => (KINDS.includes(F.mode) ? F.mode : 'route');
function sortState() {
  const m = modeKind();
  let k = COLS[m][F[SORT_KEY[m]]] !== undefined ? F[SORT_KEY[m]] : { route: 'profit', demand: 'day', consume: 'use', relist: 'day', reproc: 'day' }[m];
  if (m === 'route' && k === 'profit' && structOrder()) k = 'unit';   // 玩家建筑算不出预计利润，按每件利润排
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
const F = { sdir: {}, size: 100, csort: 'use', lossOnly: false, target: 0, win: 7, share: 10, days: 3, minDay: 0, minTurn: 0, maxStock: 0, rising: false, dsort: 'day', rsort: 'day', edits: 3, rhub: 0, rcomp: 0, psort: 'day', pin: 's', pout: 'b', mode: 'sb', rmode: 'sb', med: 7, sort: 'profit', from: 0, to: 0, local: true, cat: 0, minProfit: 1e7, minDaily: 0, minUnit: 0, minM3: 0, minQty: 0, strict: true, excl: [], custom: [], maxVol: 0, noShip: false };   // excl：排除的物品 ID；custom：[{ region, name, system, sysName }]；maxVol：单件体积上限（0 不限）；noShip：去掉舰船
const CUSTOM_MAX = 3;
const CUSTOM_TTL = 10 * 60e3;
const customCache = new Map();   // 市场 ID -> { at, quotes }
const S = { page: 1, pageKey: '', data: null, loading: null, error: null, q: '', timer: 0, rows: null, key: '', vols: {}, sm: [], smKey: '', smNote: '', cm: [], cmKey: '', cmNote: '', showCustom: false, tq: '', tOpen: false, top: [], liveVer: 0, liveRun: 0, liveNote: '' };
try { Object.assign(F, JSON.parse(localStorage.getItem('eve-hub-rank') || '{}')); } catch { /* 用默认 */ }
if (!Array.isArray(F.excl)) F.excl = [];
if (!Array.isArray(F.custom)) F.custom = [];
if (!MODES.some(([k]) => k === F.rmode)) F.rmode = 'sb';
if (MODES.some(([k]) => k === F.mode)) F.rmode = F.mode;
else if (!KINDS.includes(F.mode)) F.mode = F.rmode;
if (!MED_DAYS.includes(Number(F.med))) F.med = 7;
// 自定义市场的 ID：负数，不和交易中心 / 建筑 ID 冲突（星域 10000002 + 星系 30000142 → -2000142）
const customId = (c) => -((c.region % 1e6) * 1e6 + (c.system ? c.system % 1e6 : 0));
const save = () => { try { localStorage.setItem('eve-hub-rank', JSON.stringify(F)); } catch { /* 无痕模式 */ } };
// 各模式共用的物品筛选：排除列表、单件包装体积上限、去掉舰船（体积未知的不按体积筛）
function skipType(id, excl) {
  if (ctx.isGlobal(id) || excl.has(id)) return true;
  if (F.maxVol > 0 && (S.vols?.[id] || 0) > F.maxVol) return true;
  return F.noShip && ctx.isShip(id);
}

export function initHubRank(context) {
  ctx = context;
  ctx.structs?.on(() => { S.smKey = ''; if (S.box?.isConnected && !S.box.hidden && S.data && !S.data.loading) loadStructs(S.box); });
  let t = 0;
  ctx.structs?.onData?.(() => {
    clearTimeout(t);
    t = setTimeout(() => { if (S.sm.length) loadStructs(S.box?.isConnected && !S.box.hidden && S.data && !S.data.loading ? S.box : null); }, 1500);
  });
}

// 页面空闲时预加载（只在用过倒卖排行的浏览器里调用）
export async function prefetchHubRank() {
  if (S.data || S.loading) return;
  await Promise.all([load(), loadVolumes().then((v) => { S.vols = v; })]).catch(() => {});
  if (ctx.structs?.count() && !S.smKey) await loadStructs(null);
  if (F.custom.length && !S.cm.length) await loadCustom(null);
}

// 勾选建筑的订单 → 每座建筑一张 物品 → 行情 表
async function loadStructs(box) {
  if (!ctx.structs?.count()) { S.sm = []; S.smKey = ''; S.smNote = ''; S.rows = null; return; }
  const quiet = S.sm.length > 0;   // 已有建筑数据（预加载过 / 后台刷新）：先用着，不显示「正在读取」
  if (!quiet) {
    S.smNote = '正在读取玩家建筑市场…';
    if (box) render(box);
  }
  const list = await ctx.structs.load((d, t) => { if (quiet) return; S.smNote = `正在读取玩家建筑市场 ${d}/${t}…`; const n = box?.querySelector('[data-hr-smnote]'); if (n) n.textContent = S.smNote; }).catch(() => []);
  S.sm = list.map(({ s, byType }) => {
    const quotes = new Map();
    for (const [tid, orders] of byType) quotes.set(tid, ctx.structs.quote(orders));
    return { s, quotes };
  });
  S.smKey = S.sm.map((x) => x.s.id).join(',') + '@' + Date.now();
  const bad = list.failed || [];
  S.smNote = [list.length ? `含 ${list.length} 座玩家建筑` : '', ...bad.slice(0, 3).map(({ s, why }) => `${s.label} ${why}，没算进来`)].filter(Boolean).join('；') + (bad.length > 3 ? `；另有 ${bad.length - 3} 座没算进来` : '');
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
    if (wantHist()) S.hist = true;
    const res = await fetch(`/api/v1/hubs/arbitrage?server=${ctx.server}${S.hist ? '&hist=1' : ''}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || 'HTTP ' + res.status);
    return data;
  })();
  try {
    S.data = await S.loading;
    S.at = Date.now();
    S.error = null;
    S.rows = null;
  } catch (e) {
    S.error = e.message;
  } finally {
    S.loading = null;
  }
}

// 服务端数组 → hub-compare 用的对象
const wantHist = () => modeKind() === 'route' && usesHist(F.mode);
const hasHist = () => !!S.data?.fields?.includes('med1');
function hubsOf(row, names, id) {
  const out = [];
  const idx = ['med', 'low', 'high'].map((p) => S.data.fields?.indexOf(p + F.med) ?? -1);
  const med = (h) => (h && idx[0] >= 0 ? { m: h[idx[0]], l: h[idx[1]], h: h[idx[2]] } : null);
  row.forEach((h, k) => {
    if (!h) return;
    const x = { id: S.data.hubs[k], name: names[k], sell: h[0], buy: h[1], sellQty: h[2], sellDepth: h[4], buyDepth: h[5], daily: h[6], avg: h[7], daily7: h[8] ?? null, daily1: h[9] ?? null, px: med(h) };
    const lq = liveQuote(x.id, id);   // 实时核对过的交易中心：挂单用实时的
    if (lq) Object.assign(x, { sell: lq.sell, buy: lq.buy, sellQty: lq.sellQty, sellDepth: lq.sellDepth, buyDepth: lq.buyDepth, live: true });
    if (x.sell != null || x.buy != null) out.push(x);
  });
  // 玩家建筑：同星域交易中心的日均成交与均价
  for (const { s, quotes } of [...S.sm, ...S.cm]) {
    const q = quotes.get(id);
    if (!q || (q.sell == null && q.buy == null)) continue;
    const k = S.data.hubs.indexOf(s.region);
    const h = k >= 0 ? row[k] : null;
    const own = S.sm.some((x) => x.s === s);   // 玩家建筑借用同星域交易中心的成交量，记下来源（自定义 NPC 市场本来就是星域成交量）
    out.push({ id: s.id, name: s.label, struct: true, ...q, daily: h?.[6] ?? null, avg: h?.[7] ?? null, px: med(h), volFrom: own && h ? names[k] : '' });
  }
  return out;
}

function compute() {
  if (F.mode === 'demand') return computeDemand();
  if (F.mode === 'consume') return computeConsume();
  if (F.mode === 'relist') return computeRelist();
  if (F.mode === 'reproc') return computeReproc();
  const key = JSON.stringify([{ ...F, cat: 0, sort: ROUTE_SORT[F.sort] ? F.sort : 'profit', sdir: 0, size: 0 }, ctx.TF.summary(), S.data?.updated, S.data?.fields?.length, freight(), S.smKey, S.cmKey, S.liveVer]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const names = S.data.hubs.map((id) => ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id);
  const score = ROUTE_SORT[sortState().k] || ROUTE_SORT.profit;   // 按表头的利润类列排序时，每个物品也按这一项挑路线
  const fr = freight();
  // 买入 / 卖出选的建筑被取消勾选后按「全部」算
  const places = new Set([...S.data.hubs, ...S.sm.map((x) => x.s.id), ...S.cm.map((x) => x.s.id)]);
  const from = places.has(F.from) ? F.from : 0, to = places.has(F.to) ? F.to : 0;
  const st = structOrder();
  const rows = [];
  const excl = new Set(F.excl);
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    if (skipType(id, excl)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    let best = null, loose = null;
    const better = (r, b) => !b || score(r) > score(b) || (score(r) === score(b) && r.margin > b.margin);
    for (const r of calcRoutes(hubsOf(row, names, id), F.mode, f, { vol: S.vols[id] || 0, ...fr })) {
      // 买入 / 卖出地点、本地倒卖是范围，始终生效；利润与成交量门槛可以放开看
      if (from && r.a.id !== from) continue;
      if (to && r.b.id !== to) continue;
      if (!F.local && r.local) continue;
      const miss = missOf(r, st);
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
  const key = JSON.stringify(['demand', { ...F, cat: 0, dsort: 0, sdir: 0, size: 0 }, ctx.TF.summary(), S.data?.updated, S.data?.fields?.length, freight(), S.smKey, S.cmKey]);
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
    if (!h || skipType(id, excl)) continue;
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

// 改单推荐：每个交易中心站内挂收单 → 挂卖单，按卖单侧成交占比估两边每天能走多少
const BIAS_SELL = 0.65, BIAS_BUY = 0.35;
const COMP_LOW = 3, COMP_MID = 8;   // 对手单数（两边相加）：≤ 3 低、≤ 8 中、再多是高
const compLevel = (n) => (n == null ? 0 : n <= COMP_LOW ? 1 : n <= COMP_MID ? 2 : 3);
function computeRelist() {
  const key = JSON.stringify(['relist', { ...F, cat: 0, rsort: 0, sdir: 0, size: 0 }, ctx.TF.summary(), S.data?.updated]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const disc = Math.min(1, 0.5 + 0.06 * ctx.TF.level(ctx.TF.SKILL.advBroker));
  const edits = Math.max(0, Number(F.edits) || 0);
  const share = Math.max(0.1, Number(F.share) || 10) / 100;
  const si = S.data.fields?.indexOf('sshare') ?? -1;
  const ci = [S.data.fields?.indexOf('scomp') ?? -1, S.data.fields?.indexOf('bcomp') ?? -1];
  const excl = new Set(F.excl);
  const rows = [];
  for (const [tid, row] of Object.entries(S.data.types)) {
    const id = Number(tid);
    if (skipType(id, excl)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    let best = null, loose = null;
    row.forEach((h, k) => {
      const hub = S.data.hubs[k];
      if (!h || (F.rhub && hub !== F.rhub)) return;
      const sell = h[0], buy = h[1], avg = h[7];
      const d30 = h[6], d7 = h[8] ?? null, d1 = h[9] ?? null;
      const daily = F.win === 1 ? (d1 ?? d7 ?? d30) : F.win === 7 ? (d7 ?? d30) : d30;
      if (sell == null || buy == null || !daily || !avg || sell <= buy) return;
      if (buy < avg * 0.6 || sell > avg * 1.4) return;   // 钓鱼单 / 没人成交的挂单
      const fs = si >= 0 ? h[si] : null;
      const fx = fs ?? Math.min(1, Math.max(0, (avg - buy) / (sell - buy)));
      const sellSide = fx * daily, buySide = (1 - fx) * daily;
      const qty = Math.floor(Math.min(sellSide, buySide) * share);
      const relist = edits * (1 - disc) * f.broker * (buy + sell);
      const cost = buy * (1 + f.broker);
      const unit = sell * (1 - f.sales - f.broker) - cost - relist;
      const sc = ci[0] >= 0 ? h[ci[0]] : null, bc = ci[1] >= 0 ? h[ci[1]] : null;
      const comp = sc == null && bc == null ? null : (sc || 0) + (bc || 0);
      const x = { id, cat, hub, sell, buy, avg, daily, turnover: daily * avg, f: fx, est: fs == null, sellSide, buySide, qty, relist, unit, margin: unit / cost, perDay: unit > 0 ? unit * qty : 0, comp, sc, bc };
      const miss = unit <= 0 ? '亏损' : !qty ? '每天能做不到 1 件' : x.perDay < F.minDay ? '每天利润低于门槛' : x.turnover < F.minTurn ? '日成交额低于门槛'
        : F.rcomp && compLevel(comp) > F.rcomp ? '竞争太激烈' : '';
      if (!miss) { if (!best || x.perDay > best.perDay) best = x; } else if (!F.strict && (!loose || x.unit > loose.unit)) { loose = { ...x, miss }; }
    });
    if (best) rows.push(best);
    else if (loose) rows.push({ ...loose, off: true });
  }
  rows.sort((x, y) => (x.off - y.off) || y.perDay - x.perDay);
  S.rows = rows;
  S.key = key;
  return rows;
}
// 化矿排行
function loadRp() {
  if (!S.rpLoading) {
    S.rpLoading = fetch('reprocess-data.json?v=1').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => { S.rp = d; S.rows = null; if (S.box && F.mode === 'reproc') render(S.box); })
      .catch(() => { S.rpLoading = null; });
  }
}
function computeReproc() {
  if (!S.rp) { loadRp(); return []; }
  const rp = ctx.TF.reprocSettings();
  const key = JSON.stringify(['reproc', { ...F, cat: 0, psort: 0, sdir: 0, size: 0 }, rp, ctx.TF.summary(), S.data?.updated]);
  if (S.rows && S.key === key) return S.rows;
  const f = ctx.TF.fees();
  const keep = 1 - (Number(rp.tax) || 0) / 100;
  const share = Math.max(0.1, Number(F.share) || 10) / 100;
  const outNet = F.pout === 's' ? 1 - f.sales - f.broker : 1 - f.sales;
  const excl = new Set(F.excl);
  const rows = [];
  for (const [tid, [portion, skill, m]] of Object.entries(S.rp.t)) {
    const id = Number(tid);
    const row = S.data.types[tid];
    if (!row || skipType(id, excl)) continue;
    const cat = ctx.category(id);
    if (!cat) continue;
    const y = ctx.TF.reprocYield(skill, rp);
    let best = null, loose = null;
    row.forEach((h, k) => {
      const hub = S.data.hubs[k];
      if (!h || (F.rhub && hub !== F.rhub)) return;
      const buyAt = F.pin === 's' ? h[0] : h[1], avg = h[7];
      const daily = F.win === 1 ? (h[9] ?? h[8] ?? h[6]) : F.win === 7 ? (h[8] ?? h[6]) : h[6];
      if (buyAt == null || !daily || !avg) return;
      if (F.pin === 'b' && buyAt < avg * 0.6) return;   // 离均价太远的收单收不到货
      let value = 0;
      for (let i = 0; i < m.length; i += 2) {
        const o = S.data.types[m[i]]?.[k];
        const p = o && (F.pout === 's' ? o[0] : o[1]);
        if (p == null) return;   // 产物在这个中心没有价格
        value += m[i + 1] / portion * y * p;
      }
      value *= keep * outNet;
      const cost = F.pin === 's' ? buyAt : buyAt * (1 + f.broker);
      let q = daily * share;
      if (F.pin === 's') q = Math.min(q, h[4] || 0);
      const qty = Math.floor(q / portion) * portion;
      const unit = value - cost;
      const x = { id, cat, hub, cost, value, unit, margin: unit / cost, qty, perDay: unit > 0 ? unit * qty : 0, daily, turnover: daily * avg, y, portion };
      const miss = unit <= 0 ? '亏损' : !qty ? `每天不到一批（${portion} 个）` : x.perDay < F.minDay ? '每天利润低于门槛' : '';
      if (!miss) { if (!best || x.perDay > best.perDay) best = x; } else if (!F.strict && (!loose || x.unit > loose.unit)) { loose = { ...x, miss }; }
    });
    if (best) rows.push(best);
    else if (loose) rows.push({ ...loose, off: true });
  }
  rows.sort((x, y) => (x.off - y.off) || y.perDay - x.perDay);
  S.rows = rows;
  S.key = key;
  return rows;
}
function reprocControls() {
  const { esc } = ctx;
  const rp = ctx.TF.reprocSettings();
  const pct = (v) => (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
  const hubOpts = [[0, '全部交易中心'], ...S.data.hubs.map((id) => [id, hubLabel(id)])];
  return `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>交易中心</span>${select('rhub', hubOpts)}</div>
        <div class="pi-inline"><span>进货</span>${seg('pin', [['s', '直接买'], ['b', '挂收单']])}</div>
        <div class="pi-inline"><span>产物</span>${seg('pout', [['b', '卖给收单'], ['s', '挂卖单']])}</div>
      </div>
      <div class="ind-rank-row">
        <div class="pi-inline" title="按哪段时间的日均成交量算"><span>成交量</span>${seg('win', [[1, '24 小时'], [7, '近 7 天'], [30, '近 30 天']])}</div>
        <label class="pi-inline" title="每天的成交量里你能拿下多少"><span>份额</span><input type="number" class="pi-input pi-tax" min="1" max="100" step="1" value="${esc(String(F.share))}" data-hr-num="share"><span>%</span></label>
        <div class="pi-inline"><span>每天利润 ≥</span>${select('minDay', DEMAND_MIN_DAY)}</div>
        <label class="pi-inline hr-check" title="取消勾选后，亏损或没达到门槛的物品也列出来（灰色，排在后面）"><input type="checkbox" data-hr-strict ${F.strict ? 'checked' : ''}><span>只看符合条件的</span></label>
        <a class="btn btn-ghost btn-sm" href="#appr" title="化矿率在估价页的化矿设置里改">化矿率 矿石 ${pct(ctx.TF.reprocYield(60377, rp))} · 碎铁 ${pct(ctx.TF.reprocYield(0, rp))}</a>
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}`;
}
function reprocRow(x, i) {
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const cls = x.unit > 0 ? 'up' : 'down';
  return `<tr data-hr-open="${x.id}"${x.off ? ` class="hr-off" title="不符合条件：${esc(x.miss)} · 点击查看物品详情"` : ' title="查看物品详情"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" data-item-pop="${x.id}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}</small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td>${esc(hubLabel(x.hub))}</td>
      <td class="num pi-hide-sm">${px(x.cost)}</td>
      <td class="num pi-hide-sm" title="化矿率 ${(x.y * 100).toFixed(1)}%，已扣税">${px(x.value)}</td>
      <td class="num ${cls}">${(x.unit > 0 ? '+' : '') + px(x.unit)}</td>
      <td class="num ${cls}">${(x.margin * 100).toFixed(1)}%</td>
      <td class="num" title="${x.portion} 个一批">${x.qty ? formatNumber(x.qty) : '—'}</td>
      <td class="num ${x.perDay ? 'up' : ''}">${x.perDay ? formatISK(x.perDay) : '—'}</td>
      <td class="num pi-hide-sm" title="日均成交 ${formatNumber(Math.round(x.daily))} 件">${formatISK(x.turnover)}</td></tr>`;
}
const biasOf = (x) => (x.f >= BIAS_SELL ? ['偏卖方', '大部分成交在卖单上：卖单走得快，收单很难收到货', 'warn'] : x.f <= BIAS_BUY ? ['偏买方', '大部分成交在收单上：收单收得快，卖单不好卖', 'warn'] : ['均衡', '收单和卖单两边都有成交', 'up']);
function relistControls() {
  const { esc } = ctx;
  const hubOpts = [[0, '全部交易中心'], ...S.data.hubs.map((id) => [id, hubLabel(id)])];
  return `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>交易中心</span>${select('rhub', hubOpts)}</div>
        <div class="pi-inline" title="按哪段时间的日均成交量算"><span>成交量</span>${seg('win', [[1, '24 小时'], [7, '近 7 天'], [30, '近 30 天']])}</div>
        <label class="pi-inline" title="两边每天能走的量里，你能拿下多少"><span>份额</span><input type="number" class="pi-input pi-tax" min="1" max="100" step="1" value="${esc(String(F.share))}" data-hr-num="share"><span>%</span></label>
        <label class="pi-inline" title="收单、卖单每天各改几次（改单费按交易税费设置里的技能算）"><span>每天改单</span><input type="number" class="pi-input pi-tax" min="0" max="30" step="1" value="${esc(String(F.edits))}" data-hr-num="edits"><span>次</span></label>
      </div>
      <div class="ind-rank-row">
        <div class="pi-inline"><span>每天利润 ≥</span>${select('minDay', DEMAND_MIN_DAY)}</div>
        <div class="pi-inline"><span>日成交额 ≥</span>${select('minTurn', DEMAND_MIN_TURN)}</div>
        <div class="pi-inline" title="近 24 小时在最优价附近改过价的对手单数"><span>竞争</span>${select('rcomp', [[0, '不限'], [2, '不要高的'], [1, '只看低的']])}</div>
        <label class="pi-inline hr-check" title="取消勾选后，亏损或没达到门槛的物品也列出来（灰色，排在后面）"><input type="checkbox" data-hr-strict ${F.strict ? 'checked' : ''}><span>只看符合条件的</span></label>
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}`;
}
const COMP_TAG = [null, ['低', 'up'], ['中', 'mid'], ['高', 'warn']];
function compCell(x) {
  const lv = compLevel(x.comp);
  if (!lv) return '<span class="text-muted" title="服务器还没有这项数据">—</span>';
  const [l, c] = COMP_TAG[lv];
  return `<b class="hr-tag ${c}" title="${ctx.esc(`近 24 小时改过价的对手：卖单 ${x.sc || 0} 张、收单 ${x.bc || 0} 张`)}"><span>${l}</span> ${x.comp}</b>`;
}
function relistRow(x, i) {
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const [bias, tip, c] = biasOf(x);
  const sides = `卖单侧约 ${formatNumber(Math.round(x.sellSide))} 件/天 · 收单侧约 ${formatNumber(Math.round(x.buySide))} 件/天${x.est ? '（按现价与均价估算）' : '（近 30 天每日最高 / 最低价与均价推算）'}`;
  const cls = x.unit > 0 ? 'up' : 'down';
  return `<tr data-hr-open="${x.id}" data-hr-mode-open="bs"${x.off ? ` class="hr-off" title="不符合条件：${esc(x.miss)} · 点击查看物品详情"` : ' title="查看物品详情"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" data-item-pop="${x.id}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)} <b class="hr-tag ${c}" title="${esc(tip)}">${bias}</b></small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td>${esc(hubLabel(x.hub))}</td>
      <td class="num pi-hide-sm">${px(x.buy)}</td>
      <td class="num pi-hide-sm">${px(x.sell)}</td>
      <td class="num ${cls}" title="已扣改单费每件 ${px(x.relist)}">${(x.unit > 0 ? '+' : '') + px(x.unit)}</td>
      <td class="num ${cls}">${(x.margin * 100).toFixed(1)}%</td>
      <td class="num" title="${esc(sides)}">${Math.round(x.f * 100)}%${x.est ? '<small class="text-muted"> 估</small>' : ''}</td>
      <td class="num" title="${esc(sides)}">${x.qty ? formatNumber(x.qty) : '—'}</td>
      <td class="num">${compCell(x)}</td>
      <td class="num ${x.perDay ? 'up' : ''}">${x.perDay ? formatISK(x.perDay) : '—'}</td>
      <td class="num pi-hide-sm" title="日均成交 ${formatNumber(Math.round(x.daily))} 件">${formatISK(x.turnover)}</td></tr>`;
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
    if (skipType(id, excl)) continue;
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
  return `<tr data-hr-open="${x.id}" title="查看物品详情">
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" data-item-pop="${x.id}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}${x.trend >= RISING ? ' <b class="hr-tag up" title="近 7 天日均成交量比 30 天高 30% 以上">成交上涨</b>' : ''}</small></span>
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
  return html || '<div class="kb-suggest-group">没有匹配的市场</div>';
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
  if (F.custom.length >= CUSTOM_MAX) { ctx.showToast(`自定义市场最多 ${CUSTOM_MAX} 个`, 'error'); return; }
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
  return `<tr data-hr-open="${x.id}" data-hr-mode-open="${r.mode}"${x.off ? ` class="hr-off" title="不符合条件：${esc(r.miss)} · 点击查看物品详情"` : ' title="查看物品详情"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" data-item-pop="${x.id}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}${tags.map(([t, tip, c]) => ` <b class="hr-tag ${c}" title="${esc(tip)}">${t}</b>`).join('')}</small></span>
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

// 点击排行里的物品：打开单物品行情窗口（item-pop.js），不用切走排行页；这一行的路线与利润显示在窗口标题下
function rowFacts(x) {
  const { formatISK, formatPrice, formatNumber } = ctx;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const r = x.r;
  if (F.mode === 'consume') return [
    ['日消耗额', formatISK(x.use)],
    ['日成交件数', formatNumber(Math.round(x.units))],
    ['最便宜', x.cheap ? `${hubLabel(x.cheap.hub)} ${px(x.cheap.price)}` : '—']];
  if (F.mode === 'reproc') return [
    ['交易中心', hubLabel(x.hub)],
    ['进货价', px(x.cost)], ['化矿后价值', px(x.value)],
    ['每件利润', `${x.unit > 0 ? '+' : ''}${px(x.unit)}`, x.unit > 0 ? 'up' : 'down'],
    ['利润率', `${(x.margin * 100).toFixed(1)}%`],
    ['每天可做', x.qty ? formatNumber(x.qty) : '—'],
    x.perDay ? ['每天利润', formatISK(x.perDay), 'up'] : null].filter(Boolean);
  if (F.mode === 'relist') return [
    ['交易中心', hubLabel(x.hub)],
    ['收单价', px(x.buy)], ['卖单价', px(x.sell)],
    ['每件利润', `${x.unit > 0 ? '+' : ''}${px(x.unit)}`, x.unit > 0 ? 'up' : 'down'],
    ['利润率', `${(x.margin * 100).toFixed(1)}%`],
    ['卖单侧成交', `${Math.round(x.f * 100)}%${x.est ? '（估）' : ''}`],
    ['每天可做', x.qty ? formatNumber(x.qty) : '—'],
    ['竞争', x.comp == null ? '—' : `${COMP_TAG[compLevel(x.comp)][0]} ${x.comp}`],
    x.perDay ? ['每天利润', formatISK(x.perDay), 'up'] : null].filter(Boolean);
  if (!r) return [];
  const route = r.local ? `${r.a.name}（本地）` : `${r.a.name} → ${r.b.name}`;
  return [
    ['路线', route],
    ['进货价', px(r.buyAt)],
    ['卖出价', px(r.sellAt)],
    ['单件利润', `${r.unit > 0 ? '+' : ''}${px(r.unit)}`, r.unit > 0 ? 'up' : 'down'],
    r.margin != null ? ['利润率', `${(r.margin * 100).toFixed(1)}%`] : null,
    ['可倒数量', r.qty ? formatNumber(r.qty) : '—'],
    r.total ? ['总利润', formatISK(r.total), 'up'] : r.perDay ? ['每天利润', formatISK(r.perDay), 'up'] : null].filter(Boolean);
}

function openItemModal(id) {
  const x = (S.list || []).find((v) => v.id === id);
  ctx.openItemPop(id, { pinned: true, summary: x ? rowFacts(x) : null });
}

// 买入选了玩家建筑且挂收单，或卖出选了玩家建筑且挂卖单：这一侧没有自己的成交量
const isStruct = (id) => S.sm.some((x) => x.s.id === id);
const structOrder = () => (isStruct(F.from) && F.mode[0] !== 's') || (isStruct(F.to) && F.mode[1] !== 'b');
// 两侧里知道的那一侧能做多少（都不知道为 null）
const capOf = (r) => { const c = [r.capA, r.capB].filter((v) => v != null); return c.length ? Math.min(...c) : null; };
// 挂单一侧的成交量借自同星域交易中心
const volFrom = (r) => (F.mode[0] !== 's' && r.a.volFrom) || (F.mode[1] !== 'b' && r.b.volFrom) || '';
// 可做数量：借用交易中心成交量的标「估」；挂单一侧算不出时显示直接成交一侧的上限「≤ N」
function qtyCell(r) {
  const { formatNumber, esc } = ctx;
  if (r.qty) {
    const v = volFrom(r);
    return v ? `<span title="${esc(`玩家建筑没有成交记录，按同星域 ${v} 的成交量估`)}">${formatNumber(r.qty)} <small class="hc-sub">估</small></span>` : formatNumber(r.qty);
  }
  const c = capOf(r);
  return c ? `<span title="挂单那一侧没有成交量，最多按直接成交那一侧的订单深度">≤ ${formatNumber(c)}</span>` : '—';
}
// 路线不符合哪个条件（符合时返回空串）
function missOf(r, st) {
  if (r.unit <= 0) return '亏损';
  if (r.oddA || r.oddB) return '价格异常（疑似挂错价的单）';
  if (F.minM3 && (r.perM3 ?? 0) < F.minM3) return '每立方利润低于门槛';
  if (st) {
    if (r.unit < F.minUnit) return '每件利润低于门槛';
    const q = capOf(r);
    if (F.minQty && q != null && q < F.minQty) return '可做数量低于门槛';
    return '';
  }
  if (!r.qty) return '算不出可做数量';
  if (r.total < F.minProfit) return '预计利润低于门槛';
  if (F.minDaily && Math.max(r.a.daily || 0, r.b.daily || 0) < F.minDaily) return '日均成交低于门槛';
  return '';
}

// ---------- 按当前舰船规划 ----------
// 候选：当前筛选、排序后符合条件的跨中心路线（本地倒卖不用运），每件利润 > 0、算得出可做数量、知道体积。
// 每个物品数量不超过可做数量、货舱剩余容量与剩余预算（不填不限），分别按每立方利润、利润率从高到低装，取利润高的那种装法。
// 买入 / 卖出选了「全部」时每个物品的路线各不相同：按每一对买入地 → 卖出地各装一船，取利润最高的一条。
// 利润已扣运费设置里的运费（自己开船运可把每立方运费设为 0）。
function planHaul() {
  const P = S.plan;
  if (!(P.cargo > 0)) return null;
  const groups = new Map();
  for (const x of S.list || []) {
    const r = x.r;
    if (x.off || !r || r.local || !(r.unit > 0) || !(r.qty > 0) || !(r.vol > 0)) continue;
    const k = r.a.id + '>' + r.b.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const fill = (list) => {
    let room = P.cargo, isk = P.budget > 0 ? P.budget : Infinity;
    const items = [];
    for (const x of list) {
      const r = x.r;
      const n = Math.min(r.qty, Math.floor(room / r.vol + 1e-9), Math.floor(isk / r.cost));
      if (n <= 0) continue;
      items.push({ id: x.id, r, n });
      room -= n * r.vol;
      isk -= n * r.cost;
    }
    const sum = (f) => items.reduce((t, it) => t + it.n * f(it.r), 0);
    return { items, profit: sum((r) => r.unit), cost: sum((r) => r.cost), m3: sum((r) => r.vol) };
  };
  let best = null;
  for (const list of groups.values()) {
    for (const key of ['perM3', 'margin']) {
      const p = fill([...list].sort((x, y) => y.r[key] - x.r[key]));
      if (p.items.length && (!best || p.profit > best.profit)) best = { ...p, a: list[0].r.a, b: list[0].r.b };
    }
  }
  return best;
}

async function loadPlanShip(box) {
  S.plan = { ...(S.plan || { budget: 0 }), loading: true, error: '' };
  render(box);
  try {
    const c = await ctx.shipCargo();
    Object.assign(S.plan, { cargo: Math.round(c.cargo * 100) / 100, shipName: c.shipName, name: c.name, ship: c.ship });
  } catch (error) {
    S.plan.error = error.message;
  }
  S.plan.loading = false;
  render(box);
}

function planHtml() {
  const P = S.plan;
  if (!P || modeKind() !== 'route') return '';
  const { esc, formatISK, formatPrice, formatNumber } = ctx;
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);
  const plan = P.loading ? null : planHaul();
  S.planOut = plan;
  const shipLine = P.loading ? '<span class="pi-note">正在读取当前舰船…</span>'
    : P.error ? `<span class="pi-note">读取当前舰船失败：${esc(P.error)}，可以手填货舱容量</span>`
      : P.ship ? `<span class="pi-prod"><img src="${ctx.iconUrl(P.ship)}" alt="" width="28" height="28"><span>${esc(P.shipName)}${P.name && P.name !== P.shipName ? `<small>${esc(P.name)}</small>` : ''}</span></span>`
        : '<span class="pi-note">没绑定 ESI，手填货舱容量</span>';
  const body = P.loading ? '' : !(P.cargo > 0) ? '<p class="text-muted">填上货舱容量后开始规划</p>'
    : !plan ? '<p class="text-muted">当前筛选下没有能装上船的跨中心路线（需要每件利润为正、算得出可做数量）；可以放宽买入 / 卖出地点或利润门槛</p>'
      : `<p class="hr-plan-sum"><span>${esc(String(plan.a.name))} <span class="hc-arrow">→</span> ${esc(String(plan.b.name))}</span>
        <span>${plan.items.length} 种物品</span>
        <span>占用 ${formatNumber(Math.round(plan.m3))} / ${formatNumber(P.cargo)} m³（${Math.min(100, plan.m3 / P.cargo * 100).toFixed(0)}%）</span>
        <span>投入 ${formatISK(plan.cost)}</span><span class="up">预计利润 ${formatISK(plan.profit)}</span></p>
      <div class="pi-table-wrap"><table class="pi-table"><thead><tr><th>物品</th><th class="num">数量</th><th class="num pi-hide-sm">买入价</th><th class="num">投入</th><th class="num pi-hide-sm">卖出价</th><th class="num">利润</th><th class="num pi-hide-sm">体积</th></tr></thead><tbody>
      ${plan.items.map(({ id, r, n }) => `<tr data-hr-open="${id}" title="查看物品详情"><td><div class="pi-prod"><img src="${ctx.iconUrl(id)}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(id))}</span></div></td>
        <td class="num">${formatNumber(n)}</td><td class="num pi-hide-sm">${px(r.buyAt)}</td><td class="num">${formatISK(r.cost * n)}</td>
        <td class="num pi-hide-sm">${px(r.sellAt)}</td><td class="num up">${formatISK(r.unit * n)}</td><td class="num pi-hide-sm">${formatNumber(Math.round(r.vol * n * 100) / 100)} m³</td></tr>`).join('')}
      </tbody></table></div>`;
  return `<div class="pi-card hr-plan">
    <div class="hc-head"><h3>按当前舰船规划</h3>${shipLine}<span class="toolbar-spacer"></span>
      ${ctx.hasEsiToken?.() ? `<button class="btn btn-ghost btn-sm" data-hr-plan-ship${P.loading ? ' disabled' : ''} title="重新读取角色现在开的船（资产数据最多晚 1 小时）">重新读取舰船</button>` : ''}
      ${plan ? '<button class="btn btn-ghost btn-sm" data-hr-plan-copy title="复制为「物品名 数量」清单，可粘贴到游戏市场的多项购买">复制采购清单</button>' : ''}
      <button type="button" class="ka-close" data-hr-plan-close title="收起" aria-label="收起">×</button></div>
    <div class="ind-rank-row">
      <label class="pi-inline" title="装配后的货舱容量（已算扩展货舱、改装件与技能）；可以改"><span>货舱</span><input type="number" class="pi-input pi-tax" min="0" step="any" value="${P.cargo || ''}" data-hr-plan-cargo><span>m³</span></label>
      <label class="pi-inline" title="最多花多少 ISK 进货；留空不限"><span>预算</span><input type="number" class="pi-input" min="0" step="any" value="${P.budget || ''}" placeholder="不限" data-hr-plan-budget><span>ISK</span></label>
      <span class="pi-note">按上面的买入 / 卖出地点与筛选条件装货，利润已扣运费设置里的运费</span></div>
    ${body}</div>`;
}

const seg = (k, items) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-hr-${k}="${v}" class="${String(F[k]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const select = (k, items) => `<select class="pi-input" data-hr-sel="${k}">${items.map(([v, l]) => `<option value="${v}"${String(F[k]) === String(v) ? ' selected' : ''}>${ctx.esc(String(l))}</option>`).join('')}</select>`;

function html(all0) {
  const { esc, formatISK, formatPrice, formatNumber, TF } = ctx;
  const all = F.cat ? all0.filter((x) => x.cat.id === F.cat) : all0;
  const q = S.q.trim().toLowerCase();
  const list0 = q ? all.filter((x) => ctx.typeName(x.id).toLowerCase().includes(q) || String(x.id) === q) : all;
  const list = sortRows(list0);
  S.list = list;   // 导出 CSV 用（筛选、排序后的全部行）
  // 筛选 / 排序 / 模式变了回到第 1 页（排除物品不算，免得在后面的页上排除一个就跳回去）
  const pk = JSON.stringify([{ ...F, excl: 0 }, q]);
  if (S.pageKey !== pk) { S.pageKey = pk; S.page = 1; }
  const size = pageSize(), pages = Math.max(1, Math.ceil(list.length / size));
  S.page = Math.min(Math.max(1, S.page), pages);
  const off = (S.page - 1) * size;
  const top = list.slice(off, off + size);
  S.top = modeKind() === 'route' ? top : [];
  const hubOpts = [[0, '全部'], ...S.data.hubs.map((id) => [id, ctx.regions.find((r) => r.id === id)?.hub.name.split(' ')[0].replace(/海\d+$/, '') || id]),
    ...S.sm.map(({ s }) => [s.id, s.label]), ...S.cm.map(({ s }) => [s.id, s.label])];
  const catName = F.cat ? catNameOf(F.cat) : '';
  const noVol = !all0.length && F.mode !== 'sb' && Object.values(S.data.types).every((r) => r.every((h) => !h || h[6] == null));
  const noHist = !all0.length && wantHist() && !hasHist();
  const name = (h) => esc(String(h.name));
  const px = (v) => Math.abs(v) >= 1e6 ? formatISK(v) : formatPrice(v);   // 大额用 M / B，表格放得下
  const ok = list.filter((x) => !x.off).length;
  const sign = (v) => (v > 0 ? '+' : '') + px(v);
  const D = F.mode === 'demand', C = F.mode === 'consume', RL = F.mode === 'relist', RP = F.mode === 'reproc';
  const rows = RP ? top.map((x, i) => reprocRow(x, off + i)).join('') : RL ? top.map((x, i) => relistRow(x, off + i)).join('') : C ? top.map((x, i) => consumeRow(x, off + i)).join('') : D ? top.map((x, i) => demandRow(x, off + i)).join('') : top.map((x, i0) => {
    const i = off + i0;
    const r = x.r;
    const cls = r.unit > 0 ? 'up' : 'down';
    return `<tr data-hr-open="${x.id}"${x.off ? ` class="hr-off" title="不符合条件：${esc(r.miss)} · 点击查看物品详情"` : ' title="查看物品详情"'}>
      <td class="pi-rank pi-hide-sm">${i + 1}</td>
      <td><div class="pi-prod"><img src="${ctx.iconUrl(x.id)}" data-item-pop="${x.id}" alt="" width="28" height="28" loading="lazy"><span>${esc(ctx.typeName(x.id))}<small>${esc(x.cat.name)}${routeTags(r)}</small></span>
        <button type="button" class="hr-hide" data-hr-hide="${x.id}" title="排除这个物品（以后不在排行里出现，可在上方「已排除」里恢复）" aria-label="排除">×</button></div></td>
      <td>${r.local ? `${name(r.a)} <small class="hc-sub">本地</small>` : `${name(r.a)} <span class="hc-arrow">→</span> ${name(r.b)}`}</td>
      <td class="num pi-hide-sm">${px(r.buyAt)}</td>
      <td class="num pi-hide-sm">${px(r.sellAt)}</td>
      <td class="num ${cls}">${sign(r.unit)}</td>
      <td class="num ${cls}">${(r.margin * 100).toFixed(1)}%</td>
      <td class="num pi-hide-sm" title="${r.vol ? formatNumber(r.vol) + ' m³ / 件' : '体积未知'}">${r.perM3 != null ? formatISK(r.perM3) : '—'}</td>
      <td class="num">${qtyCell(r)}</td>
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
        ${list.length ? exportBtnHtml('data-hr-export') : ''}
        <button class="btn btn-ghost btn-sm" data-hr-reload>刷新</button></div>
      ${S.showCustom ? `<div class="ind-rank-row hr-custom">
        <input class="pi-input" data-hr-cregion list="hrRegionList" placeholder="星域" autocomplete="off" aria-label="星域">
        <datalist id="hrRegionList">${(S.regionNames || []).map((r) => `<option value="${esc(r.name)}"></option>`).join('')}</datalist>
        <input class="pi-input" data-hr-csystem placeholder="星系（可不填 = 整个星域）" autocomplete="off" aria-label="星系">
        <button type="button" class="btn btn-primary btn-sm" data-hr-cadd${F.custom.length >= CUSTOM_MAX ? ' disabled' : ''}>添加</button>
        ${F.custom.map((c) => `<span class="ka-chip">${esc(c.sysName ? c.sysName + ' · ' + c.name : c.name)}<button type="button" class="ka-close" data-hr-cdel="${customId(c)}" aria-label="移除">×</button></span>`).join('')}
        <span class="pi-note" title="浏览器直接读该星域全部挂单；没有交易中心的星域无成交量数据，只能算直接成交">最多 ${CUSTOM_MAX} 个，大星域较慢</span></div>` : ''}
      <div class="ind-rank-row"><div class="segmented">${[['route', '倒卖路线'], ['demand', '按销量选品'], ['relist', '改单推荐'], ['reproc', '化矿倒卖'], ['consume', '消耗排行']].map(([v, l]) => `<button type="button" data-hr-kind="${v}" class="${modeKind() === v ? 'active' : ''}">${l}</button>`).join('')}</div>
        <label class="pi-inline" title="按包装体积算，单件体积大于这个数的物品不显示；留空不限"><span>单件体积 ≤</span><input type="number" class="pi-input pi-tax" min="0" step="any" value="${F.maxVol || ''}" placeholder="不限" data-hr-maxvol><span>m³</span></label>
        <label class="pi-inline hr-check"><input type="checkbox" data-hr-noship ${F.noShip ? 'checked' : ''}><span>去掉舰船</span></label></div>
      ${C || D || RL || RP ? '' : `<div class="ind-rank-row">${modePicker('hr', F.mode, F.med)}</div>`}
      ${RP ? reprocControls() : RL ? relistControls() : C ? consumeControls() : D ? demandControls() : `<div class="ind-rank-row">
        <div class="search-box lp-search"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" data-hr-q placeholder="筛选物品" value="${esc(S.q)}" spellcheck="false" aria-label="筛选物品"></div>
        <div class="pi-inline"><span>买入</span>${select('from', hubOpts)}</div>
        <div class="pi-inline"><span>卖出</span>${select('to', hubOpts)}</div>
        <label class="pi-inline hr-check"><input type="checkbox" data-hr-local ${F.local ? 'checked' : ''}><span>含本地倒卖</span></label>
        <button type="button" class="btn btn-ghost btn-sm" data-hr-plan title="读取角色现在开的船，按货舱容量规划这条路线买什么、买多少">按当前舰船规划</button>
        <label class="pi-inline hr-check" title="取消勾选后，亏损、算不出可做数量或没达到利润 / 成交量门槛的物品也列出来（灰色，排在后面）"><input type="checkbox" data-hr-strict ${F.strict ? 'checked' : ''}><span>只看符合条件的路线</span></label>
        ${F.excl.length ? `<button type="button" class="btn btn-ghost btn-sm" data-hr-excl-toggle>已排除 ${F.excl.length} 个物品</button>` : ''}
      </div>
      ${S.showExcl && F.excl.length ? `<div class="ind-rank-row hr-excl"><span class="text-muted">已排除：</span>${F.excl.map((id) => `<span class="ka-chip">${esc(ctx.typeName(id))}<button type="button" class="ka-close" data-hr-unhide="${id}" title="恢复" aria-label="恢复">×</button></span>`).join('')}
        <button type="button" class="link-btn" data-hr-unhide-all>全部恢复</button></div>` : ''}
      <div class="ind-rank-row">
        ${structOrder() ? `<div class="pi-inline" title="玩家建筑没有成交记录，挂单算不出预计利润"><span>每件利润 ≥</span>${select('minUnit', MIN_UNIT)}</div>
        <div class="pi-inline" title="直接成交那一侧最优价 5% 以内的订单件数，挡掉只有几件的钓鱼单"><span>可做数量 ≥</span>${select('minQty', MIN_QTY)}</div>` : `<div class="pi-inline"><span>预计利润 ≥</span>${select('minProfit', MIN_PROFIT)}</div>
        <div class="pi-inline"><span>日均成交 ≥</span>${select('minDaily', MIN_DAILY)}</div>`}
        <div class="pi-inline"><span>每立方利润 ≥</span>${select('minM3', MIN_M3)}</div>
      </div>`}
      ${C || RL || RP ? '' : `<div class="ind-rank-row">${freightHtml('hr')}</div>`}
      <p class="pi-note" title="${RP ? '在同一个交易中心买进物品、化矿、把产物卖掉。化矿率和再处理税用估价页的化矿设置，产出按期望值算。每天可做 = 日成交 × 份额（直接买不超过最优价 5% 以内的卖单数量），按化矿批量取整。' : RL ? '同一个交易中心挂收单收货、挂卖单出货。卖单侧成交占比：ESI 每天只有成交均价，按「均价 = f × 当天最高价 + (1 − f) × 当天最低价」解出，近 30 天按成交量加权；标「估」的是用现在的收单价、卖单价和 30 天均价近似。每天可做 = 收单侧、卖单侧每天成交量取小 × 份额；每件利润已扣销售税、两边中介费和每天的改单费。只推荐做什么，改成多少钱看市场行情。' : C ? `日成交量是五大交易中心所在星域的统计加起来（含周边玩家建筑）；消耗额 = 日成交额合计 + 近 7 天日均被击毁数 × 均价（只有宁静服有击杀数据）。建筑卖价是已启用的玩家建筑市场里的最低卖价，百分比是比最便宜的交易中心贵多少。` : D ? `目标市场的成交量是整个星域的统计（含周边玩家建筑；自定义市场借用同星域交易中心的数据），库存天数用目标市场自己的卖单；建议数量 = 日均成交 × 份额 × 计划天数，不超过进货地卖单深度（挂收单按进货地日均成交 × 份额）。挂单价偏离 30 天成交均价太多的不算。` : '买入、卖出方式可以任意组合；中位价 / 最低价 / 最高价收出是按近 ' + daysLabel(F.med) + '的成交价挂单（付中介费），成交价偏离 30 天均价超过 60%–140% 的不用（乱价成交），现价偏离挂单价 20% 以上标「现价偏离」。可做数量：直接成交按最优价 5% 以内的订单深度，挂单按星域日均成交 10%，两端取小。日均成交是整个星域的 30 天平均；挂单价偏离 30 天成交均价太多（收单低于 60%、卖单高于 140%）的不算。'}">
        ${ok} 个物品符合条件${list.length > ok ? `，另有 ${list.length - ok} 个不符合` : ''}${C || RL || RP ? '' : ` · ${freight().m3 || freight().collat ? '跨中心路线已扣运费' : '未计运费'}`} · 行情 ${S.data.updated ? new Date(S.data.updated).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'} 汇总${S.top.length ? ` · <span data-hr-live title="快照每小时汇总；本页每一行的买入地、卖出地再用 ESI 实时订单核对（与市场中心同一份数据，5 分钟刷新）">${esc(S.liveNote || '本页已按实时订单核对')}</span>` : ''}${S.data.progress ? ` · <span title="读完后自动更新">服务器${esc(S.data.progress)}</span>` : ''}${S.smNote ? ` · <span data-hr-smnote>${S.smNote.split('；').map((t) => `<span>${esc(t)}</span>`).join('；')}</span>` : ''}${S.cmNote ? ` · <span data-hr-cmnote>${esc(S.cmNote)}</span>` : ''}</p>
    </div>
    ${planHtml()}
    <div class="pi-card"><div class="pi-table-wrap"><table class="pi-table hr-table"><thead><tr>
      ${RP ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '交易中心')}${th('buy', '进货价', 'num pi-hide-sm', '挂收单的已加中介费')}${th('value', '化矿后', 'num pi-hide-sm', '一件化矿后的产物卖掉到手多少（已扣再处理税、销售税和中介费）')}${th('unit', '每件利润', 'num')}${th('margin', '利润率', 'num')}${th('qty', '每天可做', 'num')}${th('day', '每天利润', 'num')}${th('turn', '日成交额', 'num pi-hide-sm')}`
    : RL ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '交易中心')}${th('', '收单价', 'num pi-hide-sm')}${th('', '卖单价', 'num pi-hide-sm')}${th('unit', '每件利润', 'num', '已扣销售税、中介费和改单费')}${th('margin', '利润率', 'num')}${th('bias', '卖单侧成交', 'num', '成交量里有多少成交在卖单上；越接近 50% 两边越好做')}${th('qty', '每天可做', 'num', '收单侧、卖单侧每天成交量取小 × 份额')}${th('comp', '竞争', 'num', '近 24 小时在最优价附近改过价的对手单数，越少越好抢位置')}${th('day', '每天利润', 'num')}${th('turn', '日成交额', 'num pi-hide-sm')}`
    : C ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('use', '消耗额', 'num', '日成交额合计 + 被击毁折合每天的价值')}${th('turn', '日成交额', 'num pi-hide-sm')}${th('units', '日成交量', 'num', '五大交易中心日均成交量合计，悬停看各中心')}${S.data.losses7 ? th('loss', '近 7 天被击毁', 'num', '本站击杀库近 7 天被击毁的数量（舰船与部署物）') : ''}${th('trend', '趋势', 'num pi-hide-sm', '近 7 天日均成交比 30 天')}${th('price', '最便宜的交易中心')}${S.sm.length ? th('markup', '建筑卖价', '', '已启用的玩家建筑市场里的最低卖价，百分比是比最便宜的交易中心贵多少') : ''}`
    : D ? `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '进货')}${th('day', '每天利润', 'num')}${th('unit', '每件利润', 'num')}${th('qty', '建议数量', 'num')}${th('turn', '日成交额', 'num', '日均成交量 × 成交均价')}${th('trend', '趋势', 'num pi-hide-sm', '近 7 天日均成交比 30 天')}${th('stock', '库存天数', 'num pi-hide-sm', '目标市场卖单库存够卖几天')}${S.data.losses7 ? th('loss', '近 7 天被击毁', 'num pi-hide-sm', '本站击杀库近 7 天被击毁的数量（舰船与部署物）') : ''}`
    : `${th('', '#', 'pi-hide-sm')}${th('name', '物品')}${th('', '路线')}${th('buy', '买入价', 'num pi-hide-sm')}${th('sell', '卖出价', 'num pi-hide-sm')}${th('unit', '每件利润', 'num', '同时按这一项为每个物品挑路线')}${th('margin', '利润率', 'num', '同时按这一项为每个物品挑路线')}${th('m3', '每立方', 'num pi-hide-sm', '同时按这一项为每个物品挑路线')}${th('qty', '可做数量', 'num')}${th('cost', '投入', 'num pi-hide-sm')}${th('profit', '预计利润', 'num', '同时按这一项为每个物品挑路线')}`}
    </tr></thead><tbody>${rows || `<tr><td colspan="12" class="text-muted">${noHist && !C && !D ? (S.histLoading ? '正在读取成交价数据…' : '服务器还没有成交价数据，先换别的方式') : RP && !S.rp ? '读取化矿数据…' : noVol || ((D || C || RL || RP) && !hasVol()) ? '成交量读取中…' : C || RL || RP ? '没有符合条件的物品' : D ? demandEmpty() : '没有符合条件的路线'}</td></tr>`}</tbody></table></div>
      ${list.length ? pagerHtml(S.page, pages, list.length, off + 1, off + top.length) : ''}</div>
  </div>`;
}

// 导出 CSV：按当前模式的列导出筛选、排序后的全部行（ISK 原始数值，百分比写数值）
function exportRows() {
  const list = S.list || [];
  if (!list.length) return;
  const m = modeKind();
  const pct = (v) => (v == null ? null : (v - 1) * 100);
  const base = [['Type ID', (x) => x.id], ['物品', (x) => ctx.typeName(x.id)], ['分类', (x) => x.cat.name]];
  const miss = F.strict ? [] : [['不符合条件', (x) => (x.off ? x.r.miss || '' : '')]];
  const loss = S.data.losses7 ? [['近 7 天被击毁', (x) => x.loss || 0]] : [];
  let cols, name;
  if (m === 'consume') {
    name = '交易中心倒卖排行-消耗排行';
    cols = [...base, ['消耗额', (x) => x.use], ['日成交额', (x) => x.turnover], ['日成交量', (x) => x.units], ...loss,
      ...(S.data.losses7 ? [['被击毁折合每天', (x) => x.lossIsk || 0]] : []), ['趋势 %', (x) => pct(x.trend)],
      ['最便宜的交易中心', (x) => (x.cheap ? hubLabel(x.cheap.hub) : '')], ['最低卖价', (x) => x.cheap?.price ?? null], ['卖单数量', (x) => x.cheap?.qty ?? null],
      ...(S.sm.length ? [['建筑', (x) => x.st?.name ?? ''], ['建筑卖价', (x) => x.st?.price ?? null], ['比交易中心贵 %', (x) => (x.st && x.cheap ? (x.st.price / x.cheap.price - 1) * 100 : null)]] : [])];
  } else if (m === 'reproc') {
    name = '交易中心倒卖排行-化矿倒卖';
    cols = [...base, ['交易中心', (x) => hubLabel(x.hub)], ['进货价', (x) => x.cost], ['化矿后', (x) => x.value], ['每件利润', (x) => x.unit], ['利润率 %', (x) => x.margin * 100],
      ['化矿率 %', (x) => x.y * 100], ['每天可做', (x) => x.qty], ['每天利润', (x) => x.perDay], ['日成交额', (x) => x.turnover],
      ...(F.strict ? [] : [['不符合条件', (x) => (x.off ? x.miss || '' : '')]])];
  } else if (m === 'relist') {
    name = '交易中心倒卖排行-改单推荐';
    cols = [...base, ['交易中心', (x) => hubLabel(x.hub)], ['收单价', (x) => x.buy], ['卖单价', (x) => x.sell], ['每件利润', (x) => x.unit], ['利润率 %', (x) => x.margin * 100],
      ['卖单侧成交 %', (x) => x.f * 100], ['估算', (x) => (x.est ? '是' : '')], ['每天可做', (x) => x.qty], ['对手单数', (x) => x.comp], ['每天利润', (x) => x.perDay], ['日成交额', (x) => x.turnover], ['每件改单费', (x) => x.relist],
      ...(F.strict ? [] : [['不符合条件', (x) => (x.off ? x.miss || '' : '')]])];
  } else if (m === 'demand') {
    name = '交易中心倒卖排行-按销量选品';
    cols = [...base, ['进货方式', (x) => (x.r.mode === 'bs' ? '挂收单' : '直接买')], ['进货地点', (x) => (x.r.local ? x.r.b.name : x.r.a.name)],
      ['进货价', (x) => x.r.buyAt], ['卖出价', (x) => x.r.sellAt], ['每天利润', (x) => x.r.perDay || 0], ['每件利润', (x) => x.r.unit], ['建议数量', (x) => x.r.qty || 0],
      ['日成交额', (x) => x.turnover], ['日均成交量', (x) => x.daily], ['趋势 %', (x) => pct(x.trend)], ['库存天数', (x) => (x.soldOut ? 0 : x.stock)],
      ['无卖单', (x) => (x.soldOut ? '是' : '')], ...loss, ...miss];
  } else {
    name = '交易中心倒卖排行-倒卖路线';
    cols = [...base, ['买入地点', (x) => x.r.a.name], ['卖出地点', (x) => x.r.b.name], ['买入价', (x) => x.r.buyAt], ['卖出价', (x) => x.r.sellAt],
      ['每件利润', (x) => x.r.unit], ['利润率 %', (x) => x.r.margin * 100], ['每立方利润', (x) => x.r.perM3 ?? null], ['单件体积 m³', (x) => x.r.vol || null],
      ['可做数量', (x) => x.r.qty || 0], ['投入', (x) => (x.r.qty ? x.r.cost * x.r.qty : 0)], ['预计利润', (x) => x.r.total || 0],
      ['现价偏离', (x) => (devTip(x.r) ? '是' : '')], ['价格异常', (x) => (oddTip(x.r) ? '是' : '')], ...miss];
  }
  const n = exportCsv(name, cols, list);
  ctx.showToast(`已导出 ${n} 行`, 'success', 1800);
}

function demandEmpty() {
  const T = targetOf();
  if (T.pending) return `正在读取 ${ctx.esc(T.name)} 的挂单…`;
  if (!S.data.hubs.includes(T.region)) return `${ctx.esc(T.name)} 所在星域没有成交量数据`;
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
  side.innerHTML = `<div class="ind-side-section"><h4>分类</h4>${btn(0, '全部分类', total)}${cats.map(([id, c]) => btn(id, c.name, c.n)).join('')}</div>`;
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
    box.innerHTML = `<div class="pi-card"><h3>交易中心倒卖排行</h3><div class="pi-loading">正在汇总五大交易中心挂单${S.data?.progress ? '：' + ctx.esc(S.data.progress) : '…'}</div><p class="pi-note">首次约需 1–3 分钟</p></div>`;
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
  if (S.top.length) verifyLive(box);
}

// ---------- 实时核对 ----------
// 排行先用服务器的挂单快照（每小时汇总）选品；当前这一页每一行的买入地、卖出地再用 ESI 实时订单核对，
// 订单走市场中心的缓存（regionOrders，5 分钟，与物品详情共用）。快照里的单已经被买走、改价时，核对后按实时价重算，路线变了的重新排序，
// 新排进本页的物品接着核对。玩家建筑与自定义市场本来就是实时读的，不用核对。
const LIVE_TTL = 5 * 60e3;
const live = new Map();   // 星域:物品 -> { at, q }
function liveQuote(region, id) {
  const h = live.get(region + ':' + id);
  return h && Date.now() - h.at < LIVE_TTL ? h.q : null;
}
function verifyLive(box) {
  if (!ctx.regionOrders) return;
  const hubIds = new Set(S.data.hubs);
  const todo = [];
  for (const x of S.top) {
    for (const h of [x.r?.a, x.r?.b]) {
      if (!h || !hubIds.has(h.id) || h.live) continue;
      const k = h.id + ':' + x.id;
      if (live.has(k) && Date.now() - live.get(k).at < LIVE_TTL) continue;
      if (!todo.some((t) => t.k === k)) todo.push({ k, region: h.id, id: x.id });
    }
  }
  if (!todo.length) { if (S.liveNote) { S.liveNote = ''; const n = box.querySelector('[data-hr-live]'); if (n) n.textContent = '本页已按实时订单核对'; } return; }
  const run = ++S.liveRun;
  let done = 0;
  const note = () => { const n = box.querySelector('[data-hr-live]'); if (n) n.textContent = S.liveNote; };
  S.liveNote = `实时核对 0/${todo.length}`;
  note();
  const queue = [...todo];
  Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length && run === S.liveRun) {
      const t = queue.shift();
      const station = ctx.regions.find((r) => r.id === t.region)?.hub.id;
      try {
        const orders = await ctx.regionOrders(t.id, t.region);
        live.set(t.k, { at: Date.now(), q: ctx.quote((orders || []).filter((o) => o.location_id === station)) });
      } catch { live.set(t.k, { at: Date.now(), q: null }); }   // 读不到：沿用快照
      S.liveNote = `实时核对 ${++done}/${todo.length}`;
      note();
    }
  })).then(() => {
    if (run !== S.liveRun || !box.isConnected || box.hidden) return;
    S.liveNote = '';
    S.liveVer++;
    S.rows = null;
    render(box);   // 重排后新进本页的物品会接着核对
  });
}

// 用到成交价但手上的汇总没带这些字段：带 hist=1 再取一次
function needHist(box) {
  if (!wantHist() || hasHist() || S.histLoading) return;
  S.histLoading = true;
  render(box);
  load(true).finally(() => { S.histLoading = false; render(box); });
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
  else if (Date.now() - (S.at || 0) > 10 * 60e3) load(true).then(() => render(box));   // 预加载的结果放久了：先显示，后台换新（服务器 30 分钟汇总一次）
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
    const mk = modeClick(e.target, 'hr', F.mode, F.med);
    if (mk) { [F.mode, F.med] = mk; F.rmode = F.mode; save(); render(box); needHist(box); return; }
    const kd = e.target.closest('[data-hr-kind]');
    if (kd) { F.mode = kd.dataset.hrKind === 'route' ? F.rmode : kd.dataset.hrKind; save(); render(box); needHist(box); return; }
    const b = e.target.closest('[data-hr-sort],[data-hr-win],[data-hr-dsort],[data-hr-csort],[data-hr-pin],[data-hr-pout]');
    if (b) {
      if (b.dataset.hrPin) F.pin = b.dataset.hrPin;
      if (b.dataset.hrPout) F.pout = b.dataset.hrPout;
      if (b.dataset.hrSort) F.sort = b.dataset.hrSort;
      if (b.dataset.hrWin) F.win = Number(b.dataset.hrWin);
      if (b.dataset.hrDsort) F.dsort = b.dataset.hrDsort;
      if (b.dataset.hrCsort) F.csort = b.dataset.hrCsort;
      save(); render(box); return;
    }
    if (e.target.closest('[data-hr-fees]')) { ctx.TF.openFeeDialog(); return; }
    if (e.target.closest('[data-hr-structs]')) { closeTarget(box); ctx.structs.open(); return; }
    if (e.target.closest('[data-hr-export]')) { exportRows(); return; }
    if (e.target.closest('[data-hr-plan],[data-hr-plan-ship]')) {
      if (ctx.hasEsiToken?.()) loadPlanShip(box); else { S.plan = S.plan || { budget: 0 }; render(box); }
      return;
    }
    if (e.target.closest('[data-hr-plan-close]')) { S.plan = null; render(box); return; }
    if (e.target.closest('[data-hr-plan-copy]')) {
      const text = (S.planOut?.items || []).map(({ id, n }) => `${ctx.typeName(id)} ${n}`).join('\n');
      navigator.clipboard.writeText(text).then(() => ctx.showToast('已复制采购清单', 'success'), () => ctx.showToast('复制失败', 'error'));
      return;
    }
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
    if (row) { const m = row.dataset.hrModeOpen || F.mode; if (MODES.some(([k]) => k === m)) setHubMode(m, F.med); openItemModal(Number(row.dataset.hrOpen)); }
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-hr-sel]');
    if (sel) { F[sel.dataset.hrSel] = Number(sel.value); save(); render(box); return; }
    if (e.target.matches('[data-hr-local]')) { F.local = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-strict]')) { F.strict = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-noship]')) { F.noShip = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-plan-cargo],[data-hr-plan-budget]') && S.plan) { S.plan[e.target.matches('[data-hr-plan-cargo]') ? 'cargo' : 'budget'] = Math.max(0, Number(e.target.value) || 0); render(box); return; }
    if (e.target.matches('[data-hr-maxvol]')) { F.maxVol = Math.max(0, Number(e.target.value) || 0); save(); render(box); return; }
    if (e.target.matches('[data-hr-rising]')) { F.rising = e.target.checked; save(); render(box); return; }
    if (e.target.matches('[data-hr-size]')) { F.size = Number(e.target.value); save(); render(box); return; }
    if (e.target.matches('[data-hr-jump]')) { goPage(box, Number(e.target.value) || 1); return; }
    if (e.target.matches('[data-hr-lossonly]')) { F.lossOnly = e.target.checked; save(); render(box); return; }
    const num = e.target.closest('[data-hr-num]');
    if (num) {
      const k = num.dataset.hrNum;
      const v = Math.round(Number(num.value));
      F[k] = k === 'edits' ? Math.min(30, Math.max(0, Number.isFinite(v) ? v : 3)) : Math.min(k === 'share' ? 100 : 30, Math.max(1, v || (k === 'share' ? 10 : 3)));
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
