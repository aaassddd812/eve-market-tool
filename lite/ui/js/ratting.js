// 从网站 eve-overview-clone/js/ratting.js 原样复制，改动请两边同步
// 个人中心 · 钱包 · 刷怪收益：从钱包流水算刷怪赚了多少、每小时多少
//   赏金（bounty_prizes）每 20 分钟结算一次，amount 是扣完军团税到手的钱，tax 是交给军团的税（tax_receiver_id 收税军团），
//   context_id 是星系，reason 是这 20 分钟打掉的 NPC「类型ID: 数量,…」。ESS 托管到账（ess_escrow_transfer）同样带税。
//   相邻两次结算间隔不超过 45 分钟（允许中间空一次）算同一段；每段时长 = 首末结算间隔 + 第一次结算前的 20 分钟。
//   军团税一律按 ESI 读到的军团税率算（ctx.corpTaxRate，0–1，来自 /corporations/{id}/ 的 tax_rate）：税 = 到手 × 税率 ÷ (1 − 税率)；
//   读不到税率（corpTaxRate 为 null）时才用流水里的 tax 字段。
//   掉落、打捞、蓝图等不经过钱包，这里算不到。军团税以外的扣除（联盟税、租地费等）可以填一个百分比，存在本机。
const TICK = 20 * 60e3, GAP = 45 * 60e3;
const EXTRA_KEY = 'eve-ratting-extra';
const RANGE_KEY = 'eve-ratting-range';
const RANGES = [['today', '今天'], ['7d', '7 天'], ['all', '全部']];
let ctx = null;

const readNum = (k, d) => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && localStorage.getItem(k) !== null ? v : d; } catch { return d; } };
const readStr = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* 无痕模式等 */ } };

const isBounty = (j) => j.ref_type === 'bounty_prizes';
const isEss = (j) => j.ref_type === 'ess_escrow_transfer';
const npcCount = (reason) => String(reason || '').split(',').reduce((t, part) => t + (Number(part.split(':')[1]) || 0), 0);

// 流水 → 刷怪时段（时间正序）
// rate：ESI 读到的军团税率（0–1）；null / undefined 表示没读到，改用流水里的 tax。返回的数组带 taxMode：'rate' 按税率 / 'journal' 按流水
export function rattingSessions(journal, rate = null) {
  const useRate = typeof rate === 'number' && rate >= 0 && rate < 1;
  const list = (journal || []).filter((j) => (isBounty(j) || isEss(j)) && j.date && j.amount > 0)
    .map((j) => ({ t: Date.parse(j.date), net: j.amount, tax: useRate ? j.amount * rate / (1 - rate) : Math.abs(j.tax || 0), ess: isEss(j), sys: j.context_id_type === 'eve_system' ? j.context_id : 0, npc: isBounty(j) ? npcCount(j.reason) : 0 }))
    .sort((a, b) => a.t - b.t);
  const taxMode = useRate ? 'rate' : 'journal';
  const blank = (t) => ({ start: t, end: t, ticks: 0, net: 0, tax: 0, essNet: 0, npc: 0, sys: new Map() });
  // 先只用赏金分段
  const sessions = [];
  let cur = null;
  for (const e of list) {
    if (e.ess) continue;
    if (!cur || e.t - cur.end > GAP) sessions.push(cur = blank(e.t));
    cur.net += e.net; cur.tax += e.tax; cur.ticks += 1; cur.end = e.t; cur.npc += e.npc;
    if (e.sys) cur.sys.set(e.sys, (cur.sys.get(e.sys) || 0) + e.net);
  }
  // ESS 到账不决定分段：落在某段之内或结束后 45 分钟内就算进那段，否则单独一行
  for (const e of list) {
    if (!e.ess) continue;
    let s = sessions.find((x) => !x.essOnly && e.t >= x.start - TICK && e.t <= x.end + GAP);
    if (!s) { s = Object.assign(blank(e.t), { essOnly: true }); sessions.push(s); }
    s.net += e.net; s.tax += e.tax; s.essNet += e.net;
  }
  sessions.sort((a, b) => a.start - b.start);
  for (const s of sessions) s.ms = s.essOnly ? 0 : s.end - s.start + TICK;
  sessions.taxMode = taxMode;
  return sessions;
}

const fmtDur = (ms) => {
  const m = Math.round(ms / 60e3);
  return m < 60 ? m + ' 分钟' : Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
};
const rangeStart = (r) => {
  if (r === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (r === '7d') return Date.now() - 7 * 864e5;
  return 0;
};

export function rattingHtml(journal, c) {
  ctx = c;
  const all = rattingSessions(journal, c.corpTaxRate);
  if (!all.length) {
    return `<div class="nw-card rat-card"><div class="rat-head"><h4>刷怪收益</h4></div>
      <p class="text-muted">最近的钱包流水里没有赏金记录。刷怪后赏金每 20 分钟结算一次，ESI 流水大约有 5 分钟到 1 小时的缓存。</p></div>`;
  }
  const range = readStr(RANGE_KEY, '7d');
  const extra = Math.min(100, Math.max(0, readNum(EXTRA_KEY, 0)));
  const from = rangeStart(range);
  const ss = all.filter((s) => s.end >= from);
  const sum = (k) => ss.reduce((t, s) => t + s[k], 0);
  const net = sum('net'), tax = sum('tax'), ms = sum('ms'), ticks = sum('ticks'), npc = sum('npc'), ess = sum('essNet');
  const extraCut = net * extra / 100;
  const keep = net - extraCut;
  const perH = (v, t) => (t > 0 ? v / (t / 3600e3) : 0);
  const taxRate = net + tax > 0 ? tax / (net + tax) * 100 : 0;
  const now = Date.now();
  const live = all.filter((s) => !s.essOnly).pop();
  const liveOn = !!live && now - live.end <= GAP;
  const isk = (v) => ctx.formatISK(v);

  const seg = RANGES.map(([k, l]) => `<button type="button" class="${k === range ? 'active' : ''}" data-rat-range="${k}">${l}</button>`).join('');
  const sysName = (s) => {
    const top = [...s.sys.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => ctx.esc(ctx.systemName(id)));
    return top.length ? top.slice(0, 2).join('、') + (top.length > 2 ? ' 等' : '') : '—';
  };
  const when = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const rows = ss.slice().reverse().map((s) => {
    const k = s.net * (1 - extra / 100);
    return `<tr${s === live && liveOn ? ' class="rat-live"' : ''}><td>${when(s.start)}${s === live && liveOn ? ' <span class="rat-on">进行中</span>' : ''}</td>` +
      `<td>${s.essOnly ? 'ESS 到账' : fmtDur(s.ms)}</td><td>${s.essOnly ? '—' : sysName(s)}</td><td>${s.npc ? ctx.formatNumber(s.npc) : '—'}</td>` +
      `<td>${isk(s.net + s.tax)}</td><td class="down">−${isk(s.tax)}</td><td class="up"><b>${isk(k)}</b></td><td>${s.essOnly ? '—' : '<b>' + isk(perH(k, s.ms)) + '</b>'}</td></tr>`;
  }).join('');

  return `<div class="nw-card rat-card">
    <div class="rat-head">
      <h4>刷怪收益<small>赏金 + ESS，按 20 分钟结算分段</small></h4>
      <div class="segmented rat-seg">${seg}</div>
      <label class="rat-extra" title="军团税已经从赏金里扣掉了；联盟税、租地费、保险等再按这个比例从到手里扣">其他扣除 <input type="number" min="0" max="100" step="0.5" value="${extra}" data-rat-extra> %</label>
    </div>
    ${liveOn ? `<p class="rat-live-note"><span class="rat-on">进行中</span> <span>本段 ${fmtDur(live.ms)}</span> · <span>到手</span> <b>${isk(live.net * (1 - extra / 100))}</b> · <span>每小时</span> <b>${isk(perH(live.net * (1 - extra / 100), live.ms))}</b> · <span>最后一次结算 ${Math.round((now - live.end) / 60e3)} 分钟前</span></p>` : ''}
    ${ss.length ? `<div class="valuation-grid rat-grid">
      ${ctx.valuationCard('每小时到手', isk(perH(keep, ms)) + ' ISK', '共 ' + fmtDur(ms) + '，' + ss.filter((s) => !s.essOnly).length + ' 段', 'is-total')}
      ${ctx.valuationCard('到手合计', isk(keep) + ' ISK', extra ? '已再扣 ' + extra + '%（' + isk(extraCut) + '）' : (ess ? '含 ESS ' + isk(ess) : ctx.formatNumber(ticks) + ' 次结算'), 'is-buy')}
      ${ctx.valuationCard('税前赏金', isk(net + tax) + ' ISK', npc ? '击毁 NPC ' + ctx.formatNumber(npc) + ' 艘' : '')}
      ${ctx.valuationCard('军团税', isk(tax) + ' ISK', all.taxMode === 'rate' ? '军团税率 ' + (c.corpTaxRate * 100).toFixed(1) + '%' : '实际税率 ' + taxRate.toFixed(1) + '%（读不到军团税率，按流水）', 'is-sell')}
    </div>
    <div class="table-scroll"><table class="pc-mini-table rat-table"><thead><tr><th>开始</th><th>时长</th><th>星系</th><th>NPC</th><th>税前</th><th>军团税</th><th>到手</th><th>每小时</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="text-muted">这段时间没有赏金记录。</p>'}
  </div>`;
}

// 绑定范围切换 / 其他扣除：改完重新渲染（rerender 由调用方给）
export function bindRatting(box, rerender) {
  box.querySelectorAll('[data-rat-range]').forEach((b) => b.addEventListener('click', () => { write(RANGE_KEY, b.dataset.ratRange); rerender(); }));
  const inp = box.querySelector('[data-rat-extra]');
  if (inp) inp.addEventListener('change', () => { const v = Math.min(100, Math.max(0, Number(inp.value) || 0)); write(EXTRA_KEY, v); rerender(); });
}
