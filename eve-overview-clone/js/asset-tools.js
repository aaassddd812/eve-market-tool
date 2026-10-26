// ===== 资产页扩展：净值趋势、清仓小助手 =====
// 净值趋势：每次打开资产页记一笔（每个角色每天一条，保留一年）：资产按卖价 / 收价估值、订单（卖单货值 + 收单托管）、钱包；
//          画成折线，看资产总值随时间的变化。只存在本机浏览器，换设备或清缓存就没了。
// 清仓小助手：把资产按物品合计，对比五个交易中心「直接卖给收单」与「挂卖单」的税后所得，
//          给出每种物品去哪卖、怎么卖；挂单要按成交量估算多久卖完（超过 7 天的建议直接卖收单），按交易中心分组可复制清单。
//          行情用击杀记录服务的交易中心快照（/api/v1/hubs/arbitrage，每 30 分钟汇总），未计运费，物品不在交易中心时要自己运过去。
let ctx;   // esc, formatISK, formatNumber, typeName, serverKey, store, TF, server, regions, showToast, isActive
const $ = (id) => document.getElementById(id);
const DAY = 86400e3;
const KEEP = 366;
const LIST_DAYS = 7;          // 挂单预计超过 7 天卖完的，建议直接卖收单
const LIST_BONUS = 0.03;      // 挂单比直接卖多 3% 以上才建议挂单（挂单要等、要改价）

export function initAssetTools(context) { ctx = context; }

// ---------- 净值趋势 ----------
const nwKey = (charId) => ctx.serverKey('eve-networth-' + charId);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);

export function recordNetWorth(charId, { sell, buy, orders, wallet }) {
  if (!charId || !(sell > 0)) return;
  const list = (ctx.store.getJSON(nwKey(charId), []) || []).filter((x) => x?.d);
  const point = { d: today(), s: Math.round(sell), b: Math.round(buy || 0), o: Math.round(orders || 0), w: wallet == null ? null : Math.round(wallet) };
  if (list.length && list[list.length - 1].d === point.d) list[list.length - 1] = point;
  else list.push(point);
  ctx.store.setJSON(nwKey(charId), list.slice(-KEEP));
}

const total = (p) => p.s + p.o + (p.w || 0);

export function netWorthHtml(charId) {
  const { esc, formatISK: isk } = ctx;
  const list = (ctx.store.getJSON(nwKey(charId), []) || []).filter((x) => x?.d);
  if (!list.length) return '';
  const last = list[list.length - 1];
  const prev = (days) => {
    const t = new Date(last.d).getTime() - days * DAY;
    for (let i = list.length - 1; i >= 0; i--) if (new Date(list[i].d).getTime() <= t) return list[i];
    return null;
  };
  const delta = (p, label) => {
    if (!p) return '';
    const d = total(last) - total(p);
    const pct = total(p) ? (d / total(p)) * 100 : 0;
    return `<span class="nw-delta ${d >= 0 ? 'up' : 'down'}">${label} ${d >= 0 ? '+' : ''}${isk(d)}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）</span>`;
  };
  const head = `<div class="nw-head"><h3>净值趋势</h3><b>${isk(total(last))} ISK</b>${delta(prev(1), '较前一天')}${delta(prev(7), '7 天')}${delta(prev(30), '30 天')}</div>`;
  const note = `<p class="pi-note">资产按卖价 + 订单 + 钱包${last.w == null ? '（钱包权限不足，未计入）' : ''}；每次打开资产页记一笔，每天保留最后一次，只存在本机浏览器</p>`;
  if (list.length < 2) return `<div class="nw-card">${head}<p class="text-muted">已记下今天的净值，之后每天打开资产页就能看到变化曲线</p>${note}</div>`;
  // 折线：SVG 只画线（随宽度拉伸），坐标文字与数据点用 HTML 定位，避免被拉变形
  const t0 = new Date(list[0].d).getTime(), t1 = new Date(last.d).getTime();
  const span = Math.max(DAY, t1 - t0);
  const series = [
    ['total', '净值', total],
    ['asset', '资产', (p) => p.s],
    ['wallet', '钱包', (p) => p.w || 0],
    ['orders', '订单', (p) => p.o]
  ];
  const max = Math.max(...list.map(total)) * 1.08 || 1;
  const x = (p) => ((new Date(p.d).getTime() - t0) / span) * 100;   // %
  const y = (v) => (1 - v / max) * 100;                               // %
  const lines = series.map(([cls, , f]) => `<polyline class="nw-line nw-${cls}" points="${list.map((p) => `${x(p).toFixed(2)},${y(f(p)).toFixed(2)}`).join(' ')}"/>`).join('');
  const grid = [0.25, 0.5, 0.75].map((f) => `<line class="nw-grid" x1="0" x2="100" y1="${y(max * f)}" y2="${y(max * f)}"/>`).join('');
  const ylab = [0.25, 0.5, 0.75].map((f) => `<span class="nw-ylab" style="top:${y(max * f)}%">${esc(isk(max * f))}</span>`).join('');
  const dots = list.length <= 90 ? list.map((p) => `<i class="nw-dot" style="left:${x(p)}%;top:${y(total(p))}%" title="${p.d} · 净值 ${isk(total(p))} · 资产 ${isk(p.s)} · 钱包 ${p.w == null ? '—' : isk(p.w)} · 订单 ${isk(p.o)}"></i>`).join('') : '';
  const fmtD = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const legend = series.map(([cls, label]) => `<span class="nw-key nw-${cls}"><i></i>${label}</span>`).join('');
  return `<div class="nw-card">${head}
    <div class="nw-plot"><svg class="nw-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="净值趋势">${grid}${lines}</svg>${ylab}${dots}</div>
    <div class="nw-axis"><span>${fmtD(t0)}</span><span>${fmtD(t0 + span / 2)}</span><span>${fmtD(t1)}</span></div>
    <div class="nw-legend">${legend}<span class="text-muted">${list.length} 天记录</span></div>${note}</div>`;
}

// ---------- 清仓小助手 ----------
let snap = null;   // { at, hubs: [regionId], types: { id: [[sell, buy, sellQty, buyQty, sellDepth, buyDepth, daily, avg], …] } }
let snapLoading = null;
function loadSnap() {
  if (snap) return Promise.resolve(snap);
  if (!snapLoading) {
    snapLoading = fetch('/api/v1/hubs/arbitrage?server=' + ctx.server).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!d?.types || !d.hubs?.length || d.progress && !d.updated) throw new Error(d?.progress ? '服务器正在汇总行情，稍后再试' : '没有交易中心行情'); snap = { at: d.updated, hubs: d.hubs, types: d.types }; return snap; })
      .finally(() => { snapLoading = null; });
  }
  return snapLoading;
}

const S = { minValue: 1e6, method: 'auto', focus: '' };   // minValue：只看合计价值 ≥ 的物品；method：auto 推荐 / buy 全部卖收单；focus：只看某组（交易中心:方式）

function analyze(assets) {
  const byType = new Map();
  for (const a of assets) {
    if (a.is_blueprint_copy || a.is_singleton) continue;   // 拷贝不能上市场；组装状态的舰船 / 装配中的装备要先打包
    byType.set(a.type_id, (byType.get(a.type_id) || 0) + (a.quantity || 1));
  }
  const netBuy = ctx.TF.netBuy(), netSell = ctx.TF.netSell();
  const rows = [];
  for (const [id, qty] of byType) {
    const per = snap.types[id];
    if (!per) continue;
    let best = null;
    per.forEach((h, i) => {
      if (!h) return;
      const [sell, buy, , buyQty, , buyDepth, daily] = h;
      // 直接卖：最高收单深度以内按最高价，超出部分按 9 折估（实际会一路砸到更低的收单）
      const inDepth = Math.min(qty, buyDepth || 0);
      const instant = buy ? (inDepth * buy + (qty - inDepth) * buy * 0.9) * netBuy : 0;
      const instantOk = buy && (buyQty || 0) >= qty;
      // 挂单：比最低卖价低一档；按日成交量的 1/4 估算自己能分到的量
      const listPrice = sell ? sell * 0.999 : null;
      const listNet = listPrice ? qty * listPrice * netSell : 0;
      const days = daily > 0 ? qty / (daily / 4) : Infinity;
      const c = { hub: i, region: snap.hubs[i], instant, instantOk, listNet, listPrice, days, buy, sell, daily };
      c.method = S.method === 'buy' || !listNet || days > LIST_DAYS || listNet < instant * (1 + LIST_BONUS) ? 'buy' : 'list';
      if (c.method === 'buy' && !instant) c.method = listNet ? 'list' : null;
      c.value = c.method === 'buy' ? instant : c.method === 'list' ? listNet : 0;
      if (c.value && (!best || c.value > best.value)) best = c;
    });
    if (!best || best.value < S.minValue) continue;
    const main = per[0] && per[0][1] ? qty * per[0][1] * netBuy : 0;   // 主交易中心直接卖，作对比
    rows.push({ id, qty, ...best, gain: main ? best.value - main : null });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

const hubName = (regionId) => ctx.regions.find((r) => r.id === regionId)?.hub.name || '星域 ' + regionId;

// 按「交易中心 + 方式」分组：一组就是一趟出售（复制清单用）
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.region + ':' + r.method;
    if (!groups.has(k)) groups.set(k, { key: k, region: r.region, method: r.method, rows: [], value: 0 });
    const g = groups.get(k);
    g.rows.push(r);
    g.value += r.value;
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}
const METHOD = { buy: '卖给收单', list: '挂卖单' };
const daysText = (d) => (d < 1 ? '1 天内' : `约 ${Math.ceil(d)} 天`);

function clearanceHtml(rows, groups, filters) {
  const { esc, formatISK: isk, formatNumber: num } = ctx;
  const sum = rows.reduce((t, r) => t + r.value, 0);
  const part = (m) => { const l = rows.filter((r) => r.method === m); return { n: l.length, v: l.reduce((t, r) => t + r.value, 0), days: Math.max(0, ...l.map((r) => r.days)) }; };
  const buy = part('buy'), list = part('list');
  const hero = `<section class="clr-hero">
      <div class="clr-hero-intro">
        <h3>清仓小助手</h3>
      </div>
      <div class="clr-hero-nums">
        <div class="clr-total"><span>预计可得（税后）</span><strong>${isk(sum)}<small> ISK</small></strong><em>${num(rows.length)} 种物品</em></div>
        <div class="clr-part buy"><span>立即到手</span><b>${isk(buy.v)}</b><em>卖给收单 · ${buy.n} 种</em></div>
        <div class="clr-part list"><span>挂单等待</span><b>${isk(list.v)}</b><em>${list.n ? `挂卖单 · ${list.n} 种 · 最慢${daysText(list.days)}` : '没有要挂单的'}</em></div>
      </div>
    </section>`;
  if (!rows.length) return hero + filters + '<p class="clr-empty">没有符合条件的物品：试试把「只看价值」调低</p>';
  const focus = groups.find((g) => g.key === S.focus);
  const plans = groups.map((g, k) => `<div class="clr-plan ${g.method}${focus === g ? ' on' : ''}" data-clr-focus="${g.key}" role="button" tabindex="0" aria-pressed="${focus === g}" title="点击只看这一组">
      <span class="clr-plan-no">${k + 1}</span>
      <div class="clr-plan-main"><b>${esc(hubName(g.region))}</b><span class="clr-method ${g.method}">${METHOD[g.method]}</span></div>
      <div class="clr-plan-val"><strong>${isk(g.value)}</strong><em>${g.rows.length} 种</em></div>
      <button type="button" class="btn btn-sm ${k === 0 ? 'btn-primary' : 'btn-ghost'}" data-clr-copy="${k}" title="${g.method === 'buy' ? '复制「物品名 数量」，粘贴到游戏的「多重出售」窗口' : '复制「物品名 数量」清单，到交易中心逐个挂单'}">复制清单</button>
    </div>`).join('');
  const shown = focus ? focus.rows : rows;
  const mainHub = hubName(snap.hubs[0]);
  const body = shown.slice(0, 300).map((r) => `<tr>
      <td><div class="pi-prod"><img src="https://images.evetech.net/types/${r.id}/icon?size=32" alt="" width="24" height="24" loading="lazy"><span>${esc(ctx.typeName(r.id))}</span></div></td>
      <td class="num">${num(r.qty)}</td>
      <td>${esc(hubName(r.region))}</td>
      <td><span class="clr-method ${r.method}">${METHOD[r.method]}</span>${r.method === 'buy' && !r.instantOk ? ' <span class="clr-warn" title="收单量不够，要往下砸到更低的收单价">收单不足</span>' : ''}</td>
      <td class="num">${formatP(r.method === 'buy' ? r.buy : r.listPrice)}</td>
      <td class="num"><b>${isk(r.value)}</b></td>
      <td class="num clr-gain">${r.gain > r.value * 0.01 ? '+' + isk(r.gain) : ''}</td>
      <td class="num pi-hide-sm">${r.method === 'list' ? daysText(r.days) : '立即'}</td></tr>`).join('');
  return `${hero}${filters}
    <h4 class="clr-h">出售计划<small>按交易中心分组，每组复制清单到游戏里卖</small></h4>
    <div class="clr-plans">${plans}</div>
    <div class="clr-table-head">
      ${focus ? `<span class="clr-chip">只看：${esc(hubName(focus.region))} · ${METHOD[focus.method]}<button type="button" data-clr-focus="" aria-label="显示全部">×</button></span>` : `<b>全部物品</b>`}
      <span class="text-muted">${num(shown.length)} 种${shown.length > 300 ? '，显示前 300 种' : ''}</span>
    </div>
    <div class="table-scroll"><table class="pi-table clr-table"><thead><tr><th>物品</th><th class="num">数量</th><th>去哪卖</th><th>怎么卖</th><th class="num">单价</th><th class="num">税后所得</th><th class="num" title="比在${esc(mainHub)}直接卖给收单多得">多赚</th><th class="num pi-hide-sm">卖完时间</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const formatP = (v) => (v == null ? '—' : ctx.formatISK(v));

let last = null;   // 最近一次的分组结果（复制清单用）
export async function showClearance(box, assets, onBack) {
  const draw = () => {
    const rows = analyze(assets);
    last = groupRows(rows);
    if (S.focus && !last.some((g) => g.key === S.focus)) S.focus = '';
    const seg = (name, items, cur) => `<div class="segmented">${items.map(([v, l]) => `<button type="button" data-clr-set="${name}" data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
    const filters = `
      <div class="clr-filters">
        <div class="pi-inline"><span>卖法</span>${seg('method', [['auto', '推荐'], ['buy', '全部卖给收单']], S.method)}</div>
        <div class="pi-inline"><span>只看价值 ≥</span>${seg('minValue', [[0, '全部'], [1e6, '100 万'], [1e7, '1000 万'], [1e8, '1 亿']], S.minValue)}</div>
        <details class="clr-how"${S.how ? ' open' : ''}><summary>怎么算的？</summary>
          <ul>
            <li>对比五个交易中心「直接卖给收单」和「挂卖单（比最低卖价低一档）」的税后所得，按你的技能与税费设置计算</li>
            <li>挂单按日成交量的 1/4 估算卖完时间；超过 ${LIST_DAYS} 天、或比直接卖多不到 ${LIST_BONUS * 100}% 的，建议直接卖给收单</li>
            <li>不含蓝图拷贝和组装状态的舰船；未计运费，物品不在那个交易中心要自己运过去</li>
            <li>行情为交易中心快照，${snap.at ? new Date(snap.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'} 汇总</li>
          </ul>
        </details>
      </div>`;
    box.innerHTML = `<div class="valuation-toolbar"><button type="button" class="btn btn-ghost" data-clr-back>← 返回资产</button></div>${clearanceHtml(rows, last, filters)}`;
    box.querySelector('.clr-how')?.addEventListener('toggle', (e) => { S.how = e.target.open; });
  };
  box.innerHTML = '<div class="pi-loading">读取五个交易中心行情…</div>';
  try { await loadSnap(); } catch (e) { box.innerHTML = `<div class="valuation-toolbar"><button type="button" class="btn btn-ghost" data-clr-back>← 返回资产</button></div><p class="text-muted">行情读取失败：${ctx.esc(e.message)}</p>`; bind(box, draw, onBack); return; }
  if (!ctx.isActive()) return;
  draw();
  bind(box, draw, onBack);
}

function bind(box, draw, onBack) {
  box.onclick = (e) => {
    if (e.target.closest('[data-clr-back]')) { box.onclick = null; onBack(); return; }
    const set = e.target.closest('[data-clr-set]');
    if (set) { const k = set.dataset.clrSet; S[k] = k === 'minValue' ? Number(set.dataset.v) : set.dataset.v; draw(); return; }
    const cp = e.target.closest('[data-clr-copy]');
    if (!cp) {
      const fo = e.target.closest('[data-clr-focus]');
      if (fo) { S.focus = fo.dataset.clrFocus === S.focus ? '' : fo.dataset.clrFocus; draw(); return; }
    }
    if (cp && last) {
      const g = last[Number(cp.dataset.clrCopy)];
      navigator.clipboard.writeText(g.rows.map((r) => `${ctx.typeName(r.id)}\t${r.qty}`).join('\n'))
        .then(() => ctx.showToast(`已复制 ${g.rows.length} 种物品`, 'success', 1800), () => ctx.showToast('浏览器阻止了复制', 'error'));
    }
  };
  box.onkeydown = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.clr-plan')) { e.preventDefault(); e.target.click(); }
  };
}
