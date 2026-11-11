// 实时收益（游戏日志）：赏金逐笔挂账与采矿产出，来自 logscan.js 的增量扫描，零操作。
//   今天：所有角色的赏金挂账、采矿产出与估值（按交易中心价格）。
//   活动计时：手动「开始 / 暂停 / 继续 / 结束」，只统计计时中的时间段，算每小时收益；结束后存进历史。
//   只算挂账，不算 20 分钟一次的赏金结算（钱包流水），不会重复；「钱包与刷怪」页按结算（流水）算，两边口径不同。
import { accounts } from '../esi.js';
import { store } from '../platform.js';
import { typeIcon } from '../servers.js';
import { esc, formatISK, formatNumber, fmtTime, fmtDur, lookupName, getPrices, priceOf, typeName } from '../data.js';
import * as LS from '../logscan.js';

const KEY = 'lite-activity';
const A = store.get(KEY, null) || { cur: null, hist: [] };
const save = () => store.set(KEY, A);
let box = null, tick = null;
const ids = new Map();   // 矿名 -> 物品 ID

const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const activeMs = (act, now = Date.now()) => act.segs.reduce((t, [s, e]) => t + ((e || now) - s), 0);
const inSegs = (act, t) => act.segs.some(([s, e]) => t >= s && t <= (e || Infinity));

async function mineValue(list) {
  const byOre = new Map();
  for (const [, , name, q] of list) byOre.set(name, (byOre.get(name) || 0) + q);
  for (const name of byOre.keys()) if (!ids.has(name)) ids.set(name, await lookupName(name).catch(() => null));
  const prices = await getPrices([...byOre.keys()].map((n) => ids.get(n)).filter(Boolean), { exact: true }).catch(() => new Map());
  const rows = [...byOre].map(([name, q]) => { const id = ids.get(name); const p = id ? priceOf(prices, id) : 0; return { name, id, q, p, v: q * p }; }).sort((a, b) => b.v - a.v);
  return { rows, total: rows.reduce((t, r) => t + r.v, 0) };
}

function byChar(accs, bounty, mine) {
  return accs.map((a) => ({ a, b: bounty.filter((e) => e[1] === a.character_id || e[1] === a.character_name).reduce((t, e) => t + e[2], 0), m: mine.filter((e) => e[1] === a.character_id || e[1] === a.character_name).length }))
    .filter((x) => x.b || x.m);
}

const mine = () => box?.isConnected && box.dataset.view === 'live';
async function draw() {
  if (!mine()) return;
  const accs = accounts();
  const st = LS.status();
  const today = dayStart();
  const tb = LS.bounties(accs, today), tm = LS.minings(accs, today);
  const tmv = await mineValue(tm);
  const act = A.cur;
  let actHtml = '<p class="muted">点「开始」后，只统计计时中的赏金挂账与采矿产出，可以暂停（比如回站卖货、补给）。</p>';
  if (act) {
    const ab = LS.bounties(accs, act.start).filter((e) => inSegs(act, e[0]));
    const am = LS.minings(accs, act.start).filter((e) => inSegs(act, e[0]));
    const amv = await mineValue(am);
    const ms = activeMs(act);
    const sumB = ab.reduce((t, e) => t + e[2], 0);
    const total = sumB + amv.total;
    const paused = act.segs[act.segs.length - 1][1];
    actHtml = `<div class="live-run"><span class="pill ${paused ? 'warn' : 'on'}">${paused ? '已暂停' : '计时中'}</span>
        <span class="clock" data-act>${fmtDur(ms)}</span><span class="left">开始于 ${fmtTime(act.start)}${act.segs.length > 1 ? ' · 暂停过 ' + (act.segs.length - 1) + ' 次' : ''}</span></div>
      <div class="stats" style="margin-top:10px">
        <div class="stat"><div class="l">每小时</div><div class="v">${formatISK(ms ? total / (ms / 3600e3) : 0)}<small>ISK</small></div><div class="d">赏金 + 采矿估值</div></div>
        <div class="stat"><div class="l">赏金挂账</div><div class="v up">${formatISK(sumB)}<small>ISK</small></div><div class="d">${ab.length} 笔</div></div>
        <div class="stat"><div class="l">采矿产出</div><div class="v">${formatISK(amv.total)}<small>ISK</small></div><div class="d">${amv.rows.length ? amv.rows.slice(0, 2).map((r) => esc(r.name) + ' ' + formatNumber(r.q)).join('、') : '—'}</div></div>
        <div class="stat"><div class="l">合计</div><div class="v">${formatISK(total)}<small>ISK</small></div><div class="d">${byChar(accs, ab, am).map((x) => esc(x.a.character_name)).join('、') || '还没有记录'}</div></div>
      </div>`;
  }
  if (!mine()) return;
  box.innerHTML = `<div class="card">
    <div class="head-row"><h3>实时收益<small>游戏日志里的赏金挂账与采矿产出</small></h3><span class="grow"></span>
      <span class="small ${st.lastErr ? 'down' : 'muted'}">${st.lastErr ? esc(st.lastErr) : st.dir ? '日志：' + esc(st.dir) + (st.lastScan ? ' · ' + new Date(st.lastScan).toLocaleTimeString('zh-CN', { hour12: false }) + ' 扫描' : '') : st.inApp ? '正在找日志文件夹…' : '浏览器预览没有日志'}</span></div>
  </div>
  <div class="card">
    <div class="head-row"><h4>活动计时</h4><span class="grow"></span>
      ${!act ? '<button class="btn primary" data-a="start">开始</button>'
        : (act.segs[act.segs.length - 1][1] ? '<button class="btn primary" data-a="resume">继续</button>' : '<button class="btn" data-a="pause">暂停</button>') + '<button class="btn danger" data-a="end">结束</button>'}
    </div>
    ${actHtml}
  </div>
  <div class="card">
    <h4>今天<small>${new Date(today).toLocaleDateString('zh-CN')} 起，全部角色</small></h4>
    <div class="stats">
      <div class="stat"><div class="l">赏金挂账</div><div class="v up">${formatISK(tb.reduce((t, e) => t + e[2], 0))}<small>ISK</small></div><div class="d">${tb.length} 笔</div></div>
      <div class="stat"><div class="l">采矿产出</div><div class="v">${formatISK(tmv.total)}<small>ISK</small></div><div class="d">${formatNumber(tm.reduce((t, e) => t + e[3], 0))} 单位</div></div>
    </div>
    ${byChar(accs, tb, tm).length ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>角色</th><th class="r">赏金挂账</th><th class="r">采矿次数</th></tr></thead><tbody>
      ${byChar(accs, tb, tm).map((x) => `<tr><td>${esc(x.a.character_name)}</td><td class="r">${formatISK(x.b)}</td><td class="r">${x.m}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${tmv.rows.length ? `<h4 style="margin-top:14px">今天采到的</h4><div class="table-wrap"><table><thead><tr><th>矿</th><th class="r">数量</th><th class="r">单价</th><th class="r">估值</th></tr></thead><tbody>
      ${tmv.rows.map((r) => `<tr><td>${r.id ? `<img class="ico" src="${typeIcon(r.id)}" alt="" loading="lazy">` + esc(typeName(r.id)) : esc(r.name) + ' <span class="muted small">（认不出，没计价）</span>'}</td><td class="r">${formatNumber(r.q)}</td><td class="r">${formatISK(r.p)}</td><td class="r">${formatISK(r.v)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${tb.length ? `<h4 style="margin-top:14px">最近的赏金</h4><div class="table-wrap"><table><thead><tr><th>时间</th><th>角色</th><th class="r">金额</th></tr></thead><tbody>
      ${tb.slice(-15).reverse().map((e) => `<tr><td>${fmtTime(e[0], true)}</td><td>${esc(accs.find((a) => a.character_id === e[1] || a.character_name === e[1])?.character_name || e[1])}</td><td class="r up">+${formatISK(e[2])}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>
  ${A.hist.length ? `<div class="card"><h4>历史活动</h4><div class="table-wrap"><table><thead><tr><th>开始</th><th class="r">时长</th><th class="r">赏金</th><th class="r">采矿</th><th class="r">每小时</th><th></th></tr></thead><tbody>
    ${A.hist.map((h, i) => `<tr><td>${fmtTime(h.start)}</td><td class="r">${fmtDur(h.ms)}</td><td class="r">${formatISK(h.bounty)}</td><td class="r">${formatISK(h.mine)}</td>
      <td class="r"><b>${formatISK(h.ms ? (h.bounty + h.mine) / (h.ms / 3600e3) : 0)}</b></td><td><button class="btn sm ghost" data-del="${i}">删除</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}

async function onClick(e) {
  const a = e.target.closest('[data-a]')?.dataset.a;
  const now = Date.now();
  if (a === 'start') A.cur = { start: now, segs: [[now, 0]] };
  if (a === 'pause' && A.cur) A.cur.segs[A.cur.segs.length - 1][1] = now;
  if (a === 'resume' && A.cur) A.cur.segs.push([now, 0]);
  if (a === 'end' && A.cur) {
    const last = A.cur.segs[A.cur.segs.length - 1];
    if (!last[1]) last[1] = now;
    const accs = accounts(), act = A.cur;
    const bounty = LS.bounties(accs, act.start).filter((x) => inSegs(act, x[0])).reduce((t, x) => t + x[2], 0);
    const mine = (await mineValue(LS.minings(accs, act.start).filter((x) => inSegs(act, x[0])))).total;
    A.hist.unshift({ start: act.start, end: now, ms: activeMs(act), bounty, mine });
    A.hist = A.hist.slice(0, 100);
    A.cur = null;
  }
  const del = e.target.closest('[data-del]');
  if (del && confirm('删除这条历史活动？')) A.hist.splice(Number(del.dataset.del), 1);
  if (a || del) { save(); draw(); }
}

LS.onScan((changed) => { if (changed || A.cur) draw().catch(() => null); });

export async function render(el) {
  box = el;
  await draw();
  el.onclick = onClick;
  clearInterval(tick);
  tick = setInterval(() => {
    if (!mine()) { clearInterval(tick); return; }
    const c = box.querySelector('[data-act]');
    if (c && A.cur) c.textContent = fmtDur(activeMs(A.cur));
  }, 1000);
}
