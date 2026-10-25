// ===== 战争：势力战争 + 军团战争 =====
// 势力战争（公开接口）：/fw/stats/ 各阵营人数、星系、击杀与胜利点；/fw/wars/ 交战关系（按对抗关系分成各条战线）；/fw/systems/ 星系争夺进度；
//   /fw/leaderboards/、/fw/leaderboards/characters/、/fw/leaderboards/corporations/ 排行榜（击杀 / 胜利点，昨天 / 上周 / 总计）。
// 军团战争（公开接口）：/wars/ 最新战争 ID（每次 2000 个，用 max_war_id 往前翻），/wars/{id}/ 双方与战果，
//   /wars/{id}/killmails/ 击杀 ID + hash，再读 /killmails/{id}/{hash}/，价值按 ESI 全服均价估算（与国服战斗记录同一套）。
// 刷新倒计时：按 ESI 响应的 Expires 头（跨域可读的安全响应头）显示星系争夺进度（约每 30 分钟更新）与阵营统计 / 排行榜的下次刷新时间，
//   归零后自动重新读取并就地更新（至少间隔 60 秒，避免 ESI 缓存未及时更新时反复请求）。
import { esiUrl, SERVER } from './server.js?v=s4';
import { skPage } from './skeleton.js?v=v17';

let ctx;   // esc, formatISK, formatNumber, fetchESI, resolveNames, officialName, eveImage, valuationCard, loadKillboard, killmailWithValue, getMarketPriceMap, openMapSystem
const S = { tab: 'fw', board: 'characters', metric: 'kills', period: 'last_week', warFilter: 'active', wars: [], warIds: [], nextMax: null, warLoading: false };
const cache = new Map();
const names = new Map();
let factionNames = {};
const $ = (id) => document.getElementById(id);

export function initWar(context) { ctx = context; }

const esc = (s) => ctx.esc(s);
function once(key, fn, ttl = 10 * 60e3) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fn();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
async function nameAll(ids) {
  const todo = [...new Set(ids.filter((id) => id && !names.has(id) && !ctx.officialName(id)))];
  if (!todo.length) return;
  const r = await ctx.resolveNames(todo).catch(() => ({ names: new Map() }));
  for (const [k, v] of r.names) names.set(k, v);
}
const nameOf = (id) => ctx.officialName(id) || factionNames[id] || names.get(id) || String(id);
// 图片服务只接受 32 / 64 / 128… 这类尺寸，统一取 64
const logo = (kind, id, size = 32) => `<img src="${ctx.eveImage(`${kind}/${id}/${kind === 'characters' ? 'portrait' : 'logo'}`, 64)}" alt="" width="${size}" height="${size}" loading="lazy">`;

// ---------- 势力战争 ----------
// 读 ESI 并记下缓存时间：expires 下次刷新，modified 数据生成时间
async function esiTimed(path) {
  const res = await fetch(esiUrl(path), { headers: { 'Accept-Language': 'zh' } });
  if (!res.ok) throw new Error('ESI ' + res.status);
  const time = (h) => { const t = Date.parse(res.headers.get(h) || ''); return Number.isFinite(t) ? t : 0; };
  return { data: await res.json(), expires: time('expires'), modified: time('last-modified') };
}

async function loadFw() {
  return once('fw', async () => {
    const [statsR, wars, systemsR, boards, table, trend] = await Promise.all([
      esiTimed('/fw/stats/'), ctx.fetchESI('/fw/wars/'), esiTimed('/fw/systems/').catch(() => ({ data: [], expires: 0, modified: 0 })),
      Promise.all(['', 'characters/', 'corporations/'].map((p) => ctx.fetchESI('/fw/leaderboards/' + p).catch(() => null))),
      fetch('./npc-corp-faction.json?v=2').then((r) => r.json()).catch(() => ({ factions: {} })),
      fetch('/api/v1/fw/trend?server=' + SERVER.id).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ]);
    factionNames = table.factions || {};
    const [factions, characters, corporations] = boards;
    const ids = [];
    for (const b of [characters, corporations]) for (const m of ['kills', 'victory_points']) for (const p of ['yesterday', 'last_week', 'active_total']) for (const x of b?.[m]?.[p] || []) ids.push(x.character_id || x.corporation_id);
    await nameAll(ids);
    return { stats: statsR.data, wars, systems: systemsR.data, trend, boards: { factions, characters, corporations },
      timing: { systems: { expires: systemsR.expires, modified: systemsR.modified }, stats: { expires: statsR.expires, modified: statsR.modified } } };
  });
}

// ---------- 刷新倒计时 ----------
const cd = (ms) => {
  if (!(ms > 0)) return '即将刷新';
  const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
// 不是今天的数据带上日期（阵营统计每天结算一次，可能是一两天前生成的）
const clock = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  const time = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};
function refreshBarHtml(timing) {
  if (!timing) return '';
  const item = (key, label, tip) => {
    const t = timing[key];
    return `<span class="fw-cd-item" title="${esc(tip)}"><em>${label}</em><b data-fw-cd="${key}">${cd(t.expires - Date.now())}</b><small>数据生成于 ${clock(t.modified)}</small></span>`;
  };
  return `<div class="fw-refresh" role="timer" aria-live="off">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>
      ${item('systems', '战场（星系争夺进度）刷新', 'ESI /fw/systems/ 约每 30 分钟更新一次：各星系的胜利点与占领方')}
      ${item('stats', '阵营统计与排行榜刷新', 'ESI /fw/stats/ 与 /fw/leaderboards/：击杀、胜利点与排行（数据每天结算一次）')}
      <span class="fw-cd-note">归零后自动更新</span>
    </div>`;
}

let ticker = 0;
let lastAuto = 0;
let autoBusy = false;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(async () => {
    const view = $('warView');
    if (!view || view.hidden || S.tab !== 'fw') return;
    const hit = cache.get('fw');
    if (!hit) return;
    const d = await hit.promise.catch(() => null);
    if (!d?.timing) return;
    const now = Date.now();
    document.querySelectorAll('[data-fw-cd]').forEach((el) => { el.textContent = cd(d.timing[el.dataset.fwCd].expires - now); });
    // 任一项到期（多等 5 秒让 ESI 缓存更新）→ 后台重新读取，读完就地替换，不显示加载状态
    const due = Object.values(d.timing).some((t) => t.expires && now > t.expires + 5e3);
    if (due && !autoBusy && now - lastAuto > 60e3) {
      autoBusy = true;
      lastAuto = now;
      cache.delete('fw');
      try {
        const fresh = await loadFw();
        if (S.tab === 'fw' && $('warBody0')) { $('warBody0').innerHTML = fwHtml(fresh); $('warBody0').querySelector('.fw-refresh')?.classList.add('flash'); }
      } catch { /* 下次再试 */ } finally { autoBusy = false; }
    }
  }, 1000);
}

function fwHtml(d) {
  const { formatNumber } = ctx;
  const enemies = (f) => d.wars.filter((w) => w.faction_id === f).map((w) => nameOf(w.against_id));
  const owned = new Map(), contested = new Map();
  for (const s of d.systems) {
    owned.set(s.occupier_faction_id, (owned.get(s.occupier_faction_id) || 0) + 1);
    if (s.contested && s.contested !== 'uncontested') contested.set(s.occupier_faction_id, (contested.get(s.occupier_faction_id) || 0) + 1);
  }
  const cards = [...d.stats].sort((a, b) => b.pilots - a.pilots).map((f) => `<div class="fw-card">
      <div class="fw-card-head">${logo('corporations', f.faction_id, 36)}<div><b>${esc(nameOf(f.faction_id))}</b><small>对抗：${esc(enemies(f.faction_id).join('、') || '—')}</small></div></div>
      <div class="fw-stats">
        <span><em>飞行员</em><b>${formatNumber(f.pilots)}</b></span>
        <span><em>控制星系</em><b>${formatNumber(f.systems_controlled)}</b>${contested.get(f.faction_id) ? `<small>${contested.get(f.faction_id)} 个被争夺</small>` : ''}</span>
        <span><em>击杀 昨天 / 上周</em><b>${formatNumber(f.kills.yesterday)} / ${formatNumber(f.kills.last_week)}</b></span>
        <span><em>胜利点 昨天 / 上周</em><b>${formatNumber(f.victory_points.yesterday)} / ${formatNumber(f.victory_points.last_week)}</b></span>
      </div></div>`).join('');
  // 争夺最激烈的星系
  const hot = d.systems.filter((s) => s.victory_points_threshold).map((s) => ({ ...s, pct: s.victory_points / s.victory_points_threshold })).sort((a, b) => b.pct - a.pct).slice(0, 15);
  const board = d.boards[S.board];
  const list = board?.[S.metric]?.[S.period] || [];
  const idKey = S.board === 'characters' ? 'character_id' : S.board === 'corporations' ? 'corporation_id' : 'faction_id';
  const kind = S.board === 'characters' ? 'characters' : 'corporations';
  const seg = (key, items) => `<div class="segmented" role="group">${items.map(([v, l]) => `<button data-fw-set="${key}" data-v="${v}" class="${S[key] === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `${refreshBarHtml(d.timing)}<div class="fw-grid">${cards}</div>
    ${frontsHtml(d)}
    <div class="fw-cols">
      <section class="pi-card"><div class="pi-card-head"><h3>排行榜</h3></div>
        <div class="fw-board-tools">${seg('board', [['characters', '飞行员'], ['corporations', '军团'], ['factions', '阵营']])}${seg('metric', [['kills', '击杀'], ['victory_points', '胜利点']])}${seg('period', [['yesterday', '昨天'], ['last_week', '上周'], ['active_total', '总计']])}</div>
        ${list.length ? `<ol class="fw-board">${list.map((x, i) => `<li><span class="fw-rank">${i + 1}</span>${logo(kind, x[idKey], 22)}<span class="fw-name">${esc(nameOf(x[idKey]))}</span><b>${formatNumber(x.amount)}</b></li>`).join('')}</ol>` : '<p class="text-muted">暂无数据</p>'}
      </section>
      <section class="pi-card"><div class="pi-card-head"><h3>争夺最激烈的星系</h3></div>
        <ol class="fw-board">${hot.map((s) => `<li><button class="link-btn fw-name" data-fw-sys="${s.solar_system_id}">${esc(ctx.officialName(s.solar_system_id) || s.solar_system_id)}</button>
          <small>${esc(nameOf(s.occupier_faction_id))}</small>${etaHtml(s, d.trend)}<i class="fw-bar"><em style="width:${Math.min(100, s.pct * 100).toFixed(1)}%"></em></i><b>${(s.pct * 100).toFixed(0)}%</b></li>`).join('')}</ol>
        
      </section>
    </div>`;
}

// 战线：/fw/wars/ 的每组对抗关系一条（帝国之间两条：加达里—盖伦特、艾玛—米玛塔尔；海盗叛乱四条：古斯塔斯对加达里 / 盖伦特、天使对艾玛 / 米玛塔尔）。
//   帝国战线按 /fw/systems/ 的所属阵营（owner）划战区，统计双方占领星系、被争夺 / 可被夺取数量和进度最高的前线星系；
//   海盗战线 ESI 没有星系级数据，只对比阵营统计。人数、击杀、胜利点都是阵营总数（含该阵营其它战线）。
// 预计时间（服务器后端 /api/v1/fw/trend 记录的胜利点快照）：按最近 6 小时推进速度估算，不是游戏里的真实倒计时
const dur = (h) => (h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟' : h < 48 ? h.toFixed(1) + ' 小时' : Math.round(h / 24) + ' 天');
// 距快照时间已经过去的部分扣掉，得到从现在起还要多久
function etaLeft(s, trend) {
  const t = trend?.systems?.[s.solar_system_id];
  if (t?.eta == null || !(t.rate > 0)) return null;
  return Math.max(0, t.eta - (Date.now() / 1000 - trend.updated) / 3600);
}
function etaHtml(s, trend) {
  const t = trend?.systems?.[s.solar_system_id];
  if (!t) return '';
  if (s.contested === 'vulnerable') {
    if (!t.vuln_since) return '';
    // 记录开始时就已经是可被夺取，只能说「至少」
    const atLeast = t.vuln_since <= trend.since;
    return `<small class="fw-eta danger" title="记录中最早出现「可被夺取」：${new Date(t.vuln_since * 1000).toLocaleString('zh-CN', { hour12: false })}">可被夺取 ${atLeast ? '至少' : '已'} ${dur((Date.now() / 1000 - t.vuln_since) / 3600)}</small>`;
  }
  if (t.rate == null) return '';
  const tip = `最近 ${t.pts} 次快照：胜利点 ${t.rate > 0 ? '+' : ''}${ctx.formatNumber(t.rate)} / 小时`;
  if (t.rate > 0 && t.eta != null) { const h = etaLeft(s, trend); return `<small class="fw-eta" title="${tip}">≈${h < 0.05 ? '即将' : dur(h)}满</small>`; }
  if (t.rate < 0) return `<small class="fw-eta down" title="${tip}">回落中</small>`;
  return `<small class="fw-eta muted" title="${tip}">停滞</small>`;
}
function trendNote(trend) {
  if (!trend) return '预计时间暂不可用（读不到服务器的胜利点记录）';
  if ((trend.snapshots || 0) < 2) return '⏱ 服务器刚开始记录胜利点，攒够两次 ESI 更新（约 1 小时）后显示各星系的预计时间';
  return `⏱ 预计时间按最近 ${trend.window_hours} 小时胜利点推进速度估算（服务器每次 ESI 更新记一笔，已记录 ${trend.snapshots} 次，自 ${clock(trend.since * 1000)} 起），只作参考，不是游戏里的倒计时`;
}
const FW_COLOR = { 500001: '#4a9fdc', 500002: '#c8553d', 500003: '#d9a93a', 500004: '#4fb37a', 500010: '#8e9aa6', 500011: '#b5653a' };
const EMPIRE = new Set([500001, 500002, 500003, 500004]);
const fwColor = (id) => FW_COLOR[id] || '#888';
// 排列顺序：加达里—盖伦特战区（及古斯塔斯）在前，艾玛—米玛塔尔战区（及天使）在后
const FW_RANK = [500001, 500004, 500003, 500002, 500010, 500011];
const rank = (id) => (FW_RANK.includes(id) ? FW_RANK.indexOf(id) : 99);
function frontsHtml(d) {
  const { formatNumber } = ctx;
  const stat = new Map(d.stats.map((f) => [f.faction_id, f]));
  const seen = new Set(), fronts = [];
  for (const w of d.wars) {
    const pair = [w.faction_id, w.against_id].sort((a, b) => rank(a) - rank(b));
    const key = pair.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    fronts.push({ a: pair[0], b: pair[1], empire: EMPIRE.has(pair[0]) && EMPIRE.has(pair[1]) });
  }
  if (!fronts.length) return '';
  fronts.sort((x, y) => (y.empire - x.empire) || rank(x.a) - rank(y.a) || rank(x.b) - rank(y.b));
  const side = (id, right) => `<span class="fw-side${right ? ' right' : ''}">${logo('corporations', id, 28)}<b>${esc(nameOf(id))}</b></span>`;
  // 双色拔河条：左右两边各占比例
  const tug = (label, va, vb, a, b, fmt = formatNumber) => {
    const sum = (va || 0) + (vb || 0);
    const pa = sum ? (va / sum) * 100 : 50;
    return `<div class="fw-tug"><span>${fmt(va || 0)}</span><em>${label}</em><span>${fmt(vb || 0)}</span>
      <i style="--a:${fwColor(a)};--b:${fwColor(b)}"><u style="width:${pa.toFixed(1)}%"></u></i></div>`;
  };
  const card = ({ a, b, empire }) => {
    const A = stat.get(a) || {}, B = stat.get(b) || {};
    let zone = '';
    if (empire) {
      const sys = d.systems.filter((s) => s.owner_faction_id === a || s.owner_faction_id === b);
      const occ = (f) => sys.filter((s) => s.occupier_faction_id === f).length;
      const fighting = sys.filter((s) => s.contested === 'contested').length, vuln = sys.filter((s) => s.contested === 'vulnerable');
      const hot = sys.filter((s) => s.victory_points_threshold && s.victory_points > 0)
        .map((s) => ({ ...s, pct: s.victory_points / s.victory_points_threshold })).sort((x, y) => y.pct - x.pct).slice(0, 5);
      const flips = sys.filter((s) => d.trend?.systems?.[s.solar_system_id]?.flipped > Date.now() / 1000 - 86400)
        .map((s) => `<button class="link-btn" data-fw-sys="${s.solar_system_id}">${esc(ctx.officialName(s.solar_system_id) || s.solar_system_id)}</button>（${dur((Date.now() / 1000 - d.trend.systems[s.solar_system_id].flipped) / 3600)}前归${esc(nameOf(s.occupier_faction_id))}）`);
      const next = sys.map((s) => ({ s, h: etaLeft(s, d.trend) })).filter((x) => x.h != null && x.s.contested !== 'vulnerable').sort((x, y) => x.h - y.h)[0];
      zone = `${tug('占领星系', occ(a), occ(b), a, b)}
        <p class="fw-front-meta">战区 ${sys.length} 个星系 · <span class="fw-warn">${fighting} 个争夺中</span>${vuln.length ? ` · <span class="fw-danger">${vuln.length} 个可被夺取：${vuln.map((s) => `<button class="link-btn" data-fw-sys="${s.solar_system_id}">${esc(ctx.officialName(s.solar_system_id) || s.solar_system_id)}</button>`).join('、')}</span>` : ''}</p>
        ${flips.length ? `<p class="fw-front-meta">24 小时内易主：${flips.join('、')}</p>` : ''}
        ${next ? `<p class="fw-next">⏱ 预计最快进入可被夺取：<button class="link-btn" data-fw-sys="${next.s.solar_system_id}">${esc(ctx.officialName(next.s.solar_system_id) || next.s.solar_system_id)}</button>（${esc(nameOf(next.s.occupier_faction_id))}）<b>${next.h < 0.05 ? '即将' : '约 ' + dur(next.h) + '后'}</b></p>` : ''}
        ${hot.length ? `<ol class="fw-board fw-hot">${hot.map((s) => `<li><i class="fw-dot" style="background:${fwColor(s.occupier_faction_id)}" title="占领方 ${esc(nameOf(s.occupier_faction_id))}"></i><button class="link-btn fw-name" data-fw-sys="${s.solar_system_id}">${esc(ctx.officialName(s.solar_system_id) || s.solar_system_id)}</button>
          ${etaHtml(s, d.trend)}<i class="fw-bar"><em style="width:${Math.min(100, s.pct * 100).toFixed(1)}%"></em></i><b>${(s.pct * 100).toFixed(0)}%</b></li>`).join('')}</ol>` : '<p class="text-muted fw-front-meta">战区内暂无星系在争夺</p>'}`;
    } else {
      zone = `${tug('控制星系', A.systems_controlled, B.systems_controlled, a, b)}`;
    }
    return `<div class="fw-front">
      <div class="fw-front-head">${side(a)}<span class="fw-vs">${empire ? '帝国战区' : 'vs'}</span>${side(b, true)}</div>
      ${tug('飞行员', A.pilots, B.pilots, a, b)}
      ${tug('上周击杀', A.kills?.last_week, B.kills?.last_week, a, b)}
      ${empire ? tug('上周胜利点', A.victory_points?.last_week, B.victory_points?.last_week, a, b) : ''}
      ${zone}</div>`;
  };
  const empires = fronts.filter((f) => f.empire), pirates = fronts.filter((f) => !f.empire);
  return `<section class="fw-fronts"><div class="fw-fronts-head"><h3>${fronts.length} 条战线</h3><small class="text-muted">人数、击杀、胜利点为阵营总数（含它在其它战线的数据）；点星系名在星图中查看</small></div>
    <p class="fw-trend-note">${trendNote(d.trend)}</p>
    ${empires.length ? `<div class="fw-front-grid">${empires.map(card).join('')}</div>` : ''}
    ${pirates.length ? `<p class="fw-front-sub">海盗叛乱战线 <small class="text-muted">ESI 不提供叛乱星系的争夺进度，只能对比阵营统计</small></p><div class="fw-front-grid pirate">${pirates.map(card).join('')}</div>` : ''}</section>`;
}

// ---------- 军团战争 ----------
async function loadWarPage() {
  if (S.warLoading) return;
  S.warLoading = true;
  try {
    const ids = await ctx.fetchESI('/wars/' + (S.nextMax ? '?max_war_id=' + S.nextMax : ''));
    const batch = ids.slice(0, 40);
    S.nextMax = batch.length ? Math.min(...batch) - 1 : null;
    const wars = [];
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < batch.length) {
        const id = batch[i++];
        const w = await ctx.fetchESI('/wars/' + id + '/').catch(() => null);
        if (w) wars.push(w);
      }
    }));
    await nameAll(wars.flatMap((w) => [w.aggressor.alliance_id || w.aggressor.corporation_id, w.defender.alliance_id || w.defender.corporation_id]));
    S.wars.push(...wars);
    S.wars.sort((a, b) => b.id - a.id);
  } finally { S.warLoading = false; }
}

const side = (x) => ({ id: x.alliance_id || x.corporation_id, kind: x.alliance_id ? 'alliances' : 'corporations', isk: x.isk_destroyed || 0, ships: x.ships_killed || 0 });
const warState = (w) => w.finished && new Date(w.finished) <= new Date() ? 'finished' : w.started && new Date(w.started) <= new Date() ? 'active' : 'declared';
const STATE_ZH = { active: '进行中', declared: '已宣战（未开始）', finished: '已结束' };
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString('zh-CN') : '—';

function warsHtml() {
  const { formatISK, formatNumber } = ctx;
  const list = S.wars.filter((w) => S.warFilter === 'all' || warState(w) === S.warFilter || (S.warFilter === 'active' && warState(w) === 'declared'));
  const seg = `<div class="segmented" role="group">${[['active', '进行中'], ['finished', '已结束'], ['all', '全部']].map(([v, l]) => `<button data-war-filter="${v}" class="${S.warFilter === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const rows = list.map((w) => {
    const a = side(w.aggressor), d = side(w.defender);
    const st = warState(w);
    return `<tr class="au-row" data-war="${w.id}" tabindex="0">
      <td><span class="war-party">${logo(a.kind, a.id, 22)}${esc(nameOf(a.id))}</span><span class="cell-sub">击毁 ${formatISK(a.isk)} · ${formatNumber(a.ships)} 艘</span></td>
      <td class="war-vs">${w.mutual ? '互相宣战' : '对'}</td>
      <td><span class="war-party">${logo(d.kind, d.id, 22)}${esc(nameOf(d.id))}</span><span class="cell-sub">击毁 ${formatISK(d.isk)} · ${formatNumber(d.ships)} 艘${w.allies?.length ? ` · ${w.allies.length} 个盟友` : ''}</span></td>
      <td><span class="pill${st === 'active' ? ' sell' : ''}">${STATE_ZH[st]}</span></td>
      <td>${fmtDay(w.declared)}<span class="cell-sub">${w.finished ? '结束 ' + fmtDay(w.finished) : w.started ? '开始 ' + fmtDay(w.started) : ''}</span></td></tr>`;
  }).join('');
  return `<div class="valuation-toolbar">${seg}<span class="toolbar-spacer"></span><span class="text-muted">已读取最新 ${S.wars.length} 场战争</span></div>
    ${list.length ? `<div class="table-scroll"><table class="pc-mini-table trade-table war-table"><thead><tr><th>宣战方</th><th></th><th>被宣战方</th><th>状态</th><th>宣战日期</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="text-muted">没有符合条件的战争</p>'}
    ${S.nextMax ? `<div class="au-more"><button class="btn btn-ghost" data-war-more${S.warLoading ? ' disabled' : ''}>${S.warLoading ? '读取中…' : '读取更早的 40 场'}</button></div>` : ''}`;
}

async function openWar(w) {
  let modal = $('warModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'warModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-war-close></div><div class="modal-content war-modal">
      <div class="modal-header"><h3 id="warTitle">战争详情</h3><button class="modal-close" data-war-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="warBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-war-close]')) modal.hidden = true; });
    // 击杀详情开着时 Esc 先关击杀详情
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && ($('killModal')?.hidden ?? true)) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
  }
  modal.hidden = false;
  const a = side(w.aggressor), d = side(w.defender);
  $('warTitle').textContent = `${nameOf(a.id)} 对 ${nameOf(d.id)}`;
  const body = $('warBody');
  const { formatISK, formatNumber } = ctx;
  const allies = w.allies || [];
  await nameAll(allies.map((x) => x.alliance_id || x.corporation_id));
  const head = `<div class="valuation-grid">
      ${ctx.valuationCard(esc(nameOf(a.id)) + '（宣战方）', formatISK(a.isk) + ' ISK', `击毁 ${formatNumber(a.ships)} 艘`, 'is-sell')}
      ${ctx.valuationCard(esc(nameOf(d.id)) + '（被宣战方）', formatISK(d.isk) + ' ISK', `击毁 ${formatNumber(d.ships)} 艘`, 'is-buy')}
      ${ctx.valuationCard('状态', STATE_ZH[warState(w)], `宣战 ${fmtDay(w.declared)}${w.finished ? ' · 结束 ' + fmtDay(w.finished) : ''}`)}
    </div>
    <p class="dyn-meta">${w.mutual ? '互相宣战' : '单方宣战'} · ${w.open_for_allies ? '接受盟友加入' : '不接受盟友'}${allies.length ? ' · 盟友：' + allies.map((x) => esc(nameOf(x.alliance_id || x.corporation_id))).join('、') : ''}</p>
    <h4 class="info-section-title">战争击杀</h4><div class="kb-list" id="warKills"><div class="pi-loading">读取战争击杀…</div></div>`;
  body.innerHTML = head;
  try {
    const refs = (await ctx.fetchESI(`/wars/${w.id}/killmails/`)).slice(0, 60);
    if (!refs.length) { $('warKills').innerHTML = '<p class="text-muted">这场战争还没有击杀</p>'; return; }
    const [kb, prices] = await Promise.all([ctx.loadKillboard(), ctx.getMarketPriceMap()]);
    const kills = [];
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < refs.length) {
        const r = refs[i++];
        try { kills.push(ctx.killmailWithValue(await ctx.fetchESI(`/killmails/${r.killmail_id}/${r.killmail_hash}/`), r.killmail_hash, prices)); } catch { /* 跳过 */ }
      }
    }));
    kills.sort((x, y) => new Date(y.killmail_time) - new Date(x.killmail_time));
    await kb.prepareKills(kills);
    if (modal.hidden || !$('warKills')) return;
    $('warKills').innerHTML = kb.killTableHtml(kills) + `<p class="text-muted valuation-note">最近 ${kills.length} 次击杀</p>`;
    kb.bindKillClicks($('warKills'), kills);
  } catch (error) {
    if ($('warKills')) $('warKills').innerHTML = '<p class="text-muted">击杀读取失败：' + esc(error.message) + '</p>';
  }
}

// ---------- 页面 ----------
async function renderBody() {
  const body = $('warBody0');
  if (!body) return;
  if (S.tab === 'fw') {
    body.innerHTML = skPage({ title: false, tabs: 3, cards: 4, rows: 8 });
    try { const d = await loadFw(); if (S.tab === 'fw') body.innerHTML = fwHtml(d); } catch (error) { body.innerHTML = '<p class="text-muted">读取失败：' + esc(error.message) + '</p>'; }
  } else {
    if (!S.wars.length) {
      body.innerHTML = skPage({ title: false, tabs: 3, rows: 10 });
      try { await loadWarPage(); } catch (error) { body.innerHTML = '<p class="text-muted">读取失败：' + esc(error.message) + '</p>'; return; }
    }
    if (S.tab === 'wars') body.innerHTML = warsHtml();
  }
}

// 预加载（modern-app.js：悬停导航按钮或常用页面空闲时调用），只取数据不渲染，打开页面时直接用
export const preload = () => (S.tab === 'fw' ? loadFw() : S.wars.length ? null : loadWarPage());

export async function showWar(hash) {
  const main = $('warMain');
  if (hash?.startsWith('#war/wars')) S.tab = 'wars';
  else if (hash?.startsWith('#war')) S.tab = hash === '#war' || hash.startsWith('#war/fw') ? 'fw' : S.tab;
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `<section class="pi-page war-page">
      <div class="pi-head"><h2>战争</h2>
        <div class="segmented" role="group" aria-label="战争类型"><button data-war-tab="fw">势力战争</button><button data-war-tab="wars">军团战争</button></div>
        <span class="toolbar-spacer"></span><button class="btn btn-ghost" data-war-reload>刷新</button></div>
      <div id="warBody0"></div></section>`;
    main.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-war-tab]');
      if (tab) { S.tab = tab.dataset.warTab; history.replaceState(null, '', location.pathname + '#war/' + S.tab); syncTabs(); renderBody(); return; }
      const set = e.target.closest('[data-fw-set]');
      if (set) { S[set.dataset.fwSet] = set.dataset.v; renderBody(); return; }
      const sys = e.target.closest('[data-fw-sys]');
      if (sys) { ctx.openMapSystem(Number(sys.dataset.fwSys)); return; }
      const f = e.target.closest('[data-war-filter]');
      if (f) { S.warFilter = f.dataset.warFilter; renderBody(); return; }
      if (e.target.closest('[data-war-more]')) { const p = loadWarPage(); renderBody(); await p; renderBody(); return; }
      if (e.target.closest('[data-war-reload]')) { cache.clear(); if (S.tab === 'wars') { S.wars = []; S.nextMax = null; } renderBody(); return; }
      const row = e.target.closest('[data-war]');
      if (row) { const w = S.wars.find((x) => x.id === Number(row.dataset.war)); if (w) openWar(w); }
    });
    main.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const row = e.target.closest('[data-war]'); if (row) row.click(); } });
  }
  syncTabs();
  startTicker();
  if (!location.hash.startsWith('#war')) history.replaceState(null, '', location.pathname + '#war/' + S.tab);
  await renderBody();
}

function syncTabs() {
  document.querySelectorAll('[data-war-tab]').forEach((b) => b.classList.toggle('active', b.dataset.warTab === S.tab));
}
