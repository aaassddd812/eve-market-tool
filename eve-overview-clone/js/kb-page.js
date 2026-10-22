// ===== 击杀记录页 =====
// 数据来自自建的击杀记录服务（server/kb_service.py，/api/kb/），收录新伊甸全部击杀；
// 所有价值按吉他海4 最低卖价与最高收购价的中间值估算。人物的生涯统计来自 zKillboard。
import { skCards, skRows, skTopCards, skBoard, skSummary, skEntityHead, skTitle, skToolbar } from './skeleton.js?v=v16r7';
import { initBr, renderBr } from './kb-br.js?v=v18r8';

let app, kb;

const API = '/api/kb/';
const IMG = (path, size) => `https://images.evetech.net/${path}?size=${size}`;
const PRICE_NOTE = '单项与总价值按吉他海4 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取全服均价）；旗舰等吉他没有卖单的物品，按全服公开合同扣除附带物品后的最低价估算。';
const KIND_ZH = { character: '人物', corporation: '军团', alliance: '联盟' };
// 子页面顶部的返回按钮，与战场统计页同款
const BACK_LINK = '<a class="btn kb-br-back kb-back-btn" href="#kb" data-kb-home><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span>返回击杀记录</span></a>';

const S = {
  names: new Map(),          // 玩家角色 / 军团 / 联盟原名
  types: new Map(),
  filters: { ship: null, location: null },
  feed: [], cursor: null, feedSeq: 0, boardSeq: 0,
  lb: { side: 'losses', by: 'character', metric: 'value' },
  rank: null,                // 完整排行榜：{ side, by, metric, days, sort, filter, data, seq }
  entity: null,              // { kind, id, stats, info, lifetime, side, feed, cursor, sort }
  status: null
};

const $ = (id) => document.getElementById(id);

// 预取：空闲时提前请求首页数据，首次打开页面直接使用（1 分钟内有效，只用一次）
const PREFETCH_TTL = 60e3;
const prefetched = new Map();   // path -> { at, promise }

function api(path) {
  const hit = prefetched.get(path);
  if (hit) {
    prefetched.delete(path);
    if (Date.now() - hit.at < PREFETCH_TTL) return hit.promise;
  }
  return request(path);
}

async function request(path) {
  const res = await fetch(API + path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '击杀记录服务 ' + res.status);
  return data;
}

// ---------- 名称 ----------
function absorbNames(map) {
  for (const [id, name] of Object.entries(map || {})) if (name) S.names.set(Number(id), name);
}

const partyName = (id) => (id ? app.officialName(id) || S.names.get(id) || 'ID ' + id : '');
const typeName = (id) => S.types.get(id) || 'Type ' + id;

async function loadTypes(ids) {
  const missing = [...new Set(ids)].filter((t) => t && !S.types.has(t));
  if (!missing.length) return;
  const names = await app.resolveTypeNames(missing);
  for (const [k, v] of names) S.types.set(k, v);
}

function typesOf(kills) {
  return kills.flatMap((k) => [k.ship_type_id, k.final.ship_type_id]);
}

function avatar(kind, id, size = 32) {
  if (!id) return '';
  const path = kind === 'character' ? `characters/${id}/portrait` : kind === 'alliance' ? `alliances/${id}/logo` : `corporations/${id}/logo`;
  return IMG(path, size);
}

function entityLink(kind, id, text) {
  if (!id) return '';
  return `<a class="kb-link" href="#kb/${kind}/${id}" data-entity="${kind}:${id}">${app.esc(text || partyName(id))}</a>`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3600e3) return Math.max(1, Math.floor(diff / 60e3)) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 86400e3 * 30) return Math.floor(diff / 86400e3) + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

// ---------- 列表 ----------
function feedRows(kills, { me } = {}) {
  let divided = false;
  return kills.map((k) => {
    const v = k.victim, f = k.final;
    // 本站只保留最近 30 天，更早的记录是实时向 zKillboard 查询的（不入库），用分隔行标出
    const divider = k.archive && !divided
      ? (divided = true, `<tr class="kb-divider"><td colspan="${me ? 6 : 5}">以下为 30 天以前的记录，实时查询自 zKillboard，价值同样按吉他中间价估算</td></tr>`)
      : '';
    const sys = kb.systemLabel(k.system_id);
    const side = me ? (v[me.key] === me.id ? 'loss' : 'kill') : null;
    return `${divider}<tr class="kb-row" data-kill="${k.id}" tabindex="0">
        ${side ? `<td class="kb-side"><span class="pill ${side === 'loss' ? 'sell' : 'buy'}">${side === 'loss' ? '损失' : '击杀'}</span></td>` : ''}
        <td class="kb-ship"><span class="kb-ship-inner"><img src="${IMG(`types/${k.ship_type_id}/icon`, 64)}" alt="" width="32" height="32" loading="lazy">
          <span><strong>${app.esc(typeName(k.ship_type_id))}</strong>${k.solo ? '<span class="kb-tag solo">单刷</span>' : ''}${k.npc ? '<span class="kb-tag npc">NPC</span>' : ''}</span></span></td>
        <td class="kb-party kb-victim-cell"><strong>${v.character_id ? entityLink('character', v.character_id) : entityLink('corporation', v.corporation_id)}</strong>
          <span class="cell-sub">${v.character_id ? entityLink('corporation', v.corporation_id) : ''}${v.alliance_id ? (v.character_id ? ' · ' : '') + entityLink('alliance', v.alliance_id) : ''}</span></td>
        <td class="kb-party kb-final-cell"><strong>${f.character_id ? entityLink('character', f.character_id) : app.esc(typeName(f.ship_type_id))}</strong>
          <span class="cell-sub">${f.corporation_id && f.character_id ? entityLink('corporation', f.corporation_id) + ' · ' : ''}${k.attackers} 名攻击者</span></td>
        <td class="kb-loc"><strong><a class="kb-link" data-location="system:${k.system_id}">${app.esc(sys.name)}</a> <span style="color:${sys.color}">${sys.secText}</span></strong>
          <span class="cell-sub">${k.region_id ? `<a class="kb-link" data-location="region:${k.region_id}">${app.esc(partyName(k.region_id))}</a>` : ''}</span></td>
        <td class="num kb-value"><strong>${app.formatISK(k.value)}</strong><span class="cell-sub">${timeAgo(k.time)}</span></td>
      </tr>`;
  }).join('');
}

const FEED_NOTICE = {
  global_end: '本站只保留最近 30 天；筛选后可查看更早记录',
  zkill_limit: 'zKillboard 最多向前翻 2 万条，可加条件缩小范围'
};

function feedTable(kills, opts = {}) {
  const note = FEED_NOTICE[opts.notice] ? `<p class="text-muted kb-note">${FEED_NOTICE[opts.notice]}</p>` : '';
  if (!kills.length) return (opts.notice === 'zkill_limit' ? '' : '<p class="text-muted kb-empty">没有符合条件的击杀记录</p>') + note;
  return `<div class="table-scroll"><table class="pc-mini-table kb-table"><thead><tr>
      ${opts.me ? '<th>类型</th>' : ''}<th>舰船</th><th>受害者</th><th>最后一击</th><th>地点</th><th class="num">价值</th>
    </tr></thead><tbody>${feedRows(kills, opts)}</tbody></table></div>${note}`;
}

// 打开击杀详情：从服务读取完整击杀邮件与逐项中间价
function openKill(id) {
  kb.openKill(null, {
    priceNote: '总价值、掉落与摧毁价值按吉他海4 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取全服均价；旗舰等吉他没有卖单的物品按全服公开合同最低价）。',
    load: async () => {
      const data = await api('kill/' + id);
      absorbNames(data.names);
      const km = data.killmail;
      const players = (km.attackers || []).filter((a) => a.character_id);
      return {
        kill: {
          ...km,
          zkb: {
            totalValue: data.value, droppedValue: data.dropped, destroyedValue: data.destroyed,
            solo: players.length === 1, npc: !players.length, awox: false, locationID: null,
            valueLabel: '吉他中间价估值'
          }
        },
        prices: new Map(Object.entries(data.prices).map(([k, v]) => [Number(k), v]))
      };
    }
  });
}

// ---------- 首页 ----------
async function renderHome() {
  S.entity = null;
  const main = $('kbMain');
  main.innerHTML = `
    <section class="kb-battles" id="kbBattles" hidden></section>
    <section class="kb-summary" id="kbSummary">${skSummary()}</section>
    <section class="kb-section">
      <h3 class="kb-section-title">最近 7 天最高损失</h3>
      <div class="kb-top" id="kbTop">${skTopCards(10)}</div>
    </section>
    <div class="kb-columns">
      <section class="kb-section kb-feed-panel">
        <div class="kb-feed-head">
          <h3 class="kb-section-title">全部击杀记录</h3>
          <div class="kb-filters" id="kbFilters"></div>
          <button class="btn btn-ghost" id="kbRefresh" title="刷新">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>刷新</span>
          </button>
        </div>
        <div id="kbFeed">${skRows(10)}</div>
        <button class="btn kb-more" id="kbMore" hidden>加载更多</button>
      </section>
      <aside class="kb-section kb-board">
        <div class="kb-board-head"><h3 class="kb-section-title">排行榜 · 最近 30 天</h3>
          <a class="kb-board-more" href="#kb/rank" data-kb-rank title="查看前 100 名的击杀、损失、效率与常用舰船">完整排行榜 ›</a></div>
        <div class="kb-board-controls" id="kbBoardControls"></div>
        <div id="kbBoard">${skBoard(10)}</div>
      </aside>
    </div>`;
  $('kbRefresh').addEventListener('click', () => { loadFeed(true); loadSummary(); });
  $('kbMore').addEventListener('click', () => loadFeed(false));
  renderFilters();
  renderBoardControls();
  renderBattles();
  await Promise.all([loadSummary(), loadTop(), loadFeed(true), loadBoard()]);
}

async function loadSummary() {
  const box = $('kbSummary');
  try {
    const [day, status] = await Promise.all([api('summary?hours=24'), api('status')]);
    S.status = status;
    renderStatus();
    if (!$('kbSummary')) return;
    const max = Math.max(...day.buckets.map((b) => b.value), 1);
    const bars = day.buckets.map((b) => `<i style="height:${Math.max(2, b.value / max * 100).toFixed(1)}%" title="${new Date(b.hour).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} · ${b.count} 次 · ${app.formatISK(b.value)} ISK"></i>`).join('');
    box.innerHTML = `
      <div class="kb-summary-cards">
        <div class="valuation-card is-sell"><span class="valuation-label">最近 24 小时总损失</span>
          <strong class="valuation-value">${app.formatISK(day.value)}<span class="unit">ISK</span></strong>
          <span class="valuation-detail">按吉他最低卖价与最高收购价的中间值估算</span></div>
        <div class="valuation-card"><span class="valuation-label">击毁舰船</span>
          <strong class="valuation-value">${app.formatNumber(day.count - day.pods)}<span class="unit">艘</span></strong>
          <span class="valuation-detail">另有 ${app.formatNumber(day.pods)} 个太空舱</span></div>
        <div class="valuation-card is-order"><span class="valuation-label">损失最多的星域</span>
          <strong class="valuation-value kb-region-value">${day.regions[0] ? `<a class="kb-link" data-location="region:${day.regions[0].region_id}">${app.esc(partyName(day.regions[0].region_id))}</a>` : '—'}</strong>
          <span class="valuation-detail">${day.regions[0] ? app.formatISK(day.regions[0].value) + ' ISK · ' + day.regions[0].count + ' 次' : ''}</span></div>
      </div>
      <div class="kb-hours"><div class="kb-hours-head"><span>每小时损失（最近 24 小时）</span><span>${app.formatISK(max)} ISK / 小时峰值</span></div><div class="kb-bars">${bars}</div></div>`;
  } catch (error) {
    box.innerHTML = '<p class="text-muted kb-empty">统计读取失败：' + app.esc(error.message) + '</p>';
  }
}

function renderStatus() {
  const st = S.status;
  if (!st || !$('kbStatus')) return;
  const live = { poll: '轮询 zKillboard', redisq: 'zKillboard 实时推送', off: '未开启' }[st.live_mode] || '启动中';
  $('kbStatus').innerHTML = `收录 <b>${app.formatNumber(st.killmails)}</b> 条 · ${st.oldest ? new Date(st.oldest).toLocaleDateString('zh-CN') : '—'} 至 ${st.newest ? timeAgo(st.newest) : '—'}
    · 实时：${live}${st.backfill && st.backfill !== '完成' ? ' · 历史：' + app.esc(st.backfill) : ''}`;
}

async function loadTop() {
  const box = $('kbTop');
  try {
    const data = await api('top?days=7&limit=10');
    absorbNames(data.names);
    await loadTypes(data.kills.map((k) => k.ship_type_id));
    if (!$('kbTop')) return;
    box.innerHTML = data.kills.map((k) => `
      <button class="kb-top-card" data-kill="${k.id}">
        <img src="${IMG(`types/${k.ship_type_id}/render`, 128)}" alt="" width="72" height="72" loading="lazy">
        <span class="kb-top-text">
          <strong>${app.esc(typeName(k.ship_type_id))}</strong>
          <small>${app.esc(partyName(k.victim.character_id) || partyName(k.victim.corporation_id))}</small>
          <small>${app.esc(kb.systemLabel(k.system_id).name)} · ${timeAgo(k.time)}</small>
        </span>
        <b>${app.formatISK(k.value)}</b>
      </button>`).join('') || '<p class="text-muted kb-empty">暂无数据</p>';
  } catch (error) {
    box.innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  }
}

function feedQuery() {
  const q = new URLSearchParams({ limit: 50 });
  if (S.filters.ship) q.set('ship', S.filters.ship.id);
  if (S.filters.location) q.set(S.filters.location.kind, S.filters.location.id);
  return q;
}

// 下一页要向 zKillboard 查询时（游标以 z: 开头）要等几秒，按钮上给出提示
function setMoreBusy(btn, busy, cursor) {
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy && cursor ? (String(cursor).startsWith('z:') ? '正在查询 zKillboard…' : '加载中…') : '加载更多';
}

// 只渲染最新一次请求的结果：筛选条件变化时旧请求作废；加载更多期间重复点击会被忽略
async function loadFeed(reset) {
  if (!reset && S.feedBusy) return;
  const seq = ++S.feedSeq;
  S.feedBusy = true;
  const box = $('kbFeed');
  if (reset) { S.feed = []; S.cursor = null; box.innerHTML = skRows(10); }
  setMoreBusy($('kbMore'), true, reset ? null : S.cursor);
  try {
    const q = feedQuery();
    if (!reset && S.cursor) q.set('cursor', S.cursor);
    const data = await api('feed?' + q);
    absorbNames(data.names);
    await loadTypes(typesOf(data.kills));
    if (seq !== S.feedSeq || !$('kbFeed')) return;
    S.feed = S.feed.concat(data.kills);
    S.cursor = data.cursor;
    box.innerHTML = feedTable(S.feed, { notice: data.notice });
    $('kbMore').hidden = !S.cursor;
  } catch (error) {
    if (seq === S.feedSeq && $('kbFeed')) box.innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  } finally {
    if (seq === S.feedSeq) {
      S.feedBusy = false;
      setMoreBusy($('kbMore'), false);
    }
  }
}

function renderFilters() {
  const chips = [];
  if (S.filters.ship) chips.push(`<span class="kb-chip"><img src="${IMG(`types/${S.filters.ship.id}/icon`, 32)}" alt="" width="16" height="16">${app.esc(S.filters.ship.name)}<button data-clear-filter="ship" aria-label="移除">×</button></span>`);
  if (S.filters.location) chips.push(`<span class="kb-chip">${S.filters.location.kind === 'region' ? '星域' : '星系'} · ${app.esc(S.filters.location.name)}<button data-clear-filter="location" aria-label="移除">×</button></span>`);
  $('kbFilters').innerHTML = chips.join('') || '<span class="kb-filter-hint">可在上方搜索舰船或地点进行筛选，两者可同时使用</span>';
}

function setFilter(key, value) {
  S.filters[key] = value;
  if (location.hash !== '#kb') { history.pushState(null, '', '#kb'); renderHome(); return; }
  renderFilters();
  loadFeed(true);
}

// ---------- 疑似会战（数据由 battles.js 每分钟更新）----------
let battles = null;
function renderBattles() {
  const box = $('kbBattles');
  if (!box || !battles || !kb) return;
  if (!battles.isBattleWatchAvailable()) { box.hidden = true; return; }
  const list = battles.getBattles(), names = battles.getBattleNames(), set = battles.getBattleSettings();
  box.hidden = false;
  const tiers = [...battles.BATTLE_TIERS].reverse();
  const rule = `${battles.BATTLE_WINDOW} 分钟内同一星系击毁（不含太空舱、NPC 击杀与 10M ISK 以下的击杀）：${tiers.map((t) => `<span class="kb-tier-chip tier-${t.key}"><i></i>${t.name.replace('会战', '')} ${t.min}+</span>`).join('')}`;
  const head = `<div class="kb-battles-head">
      <h3 class="kb-section-title"><svg class="battle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></svg>${list.length ? `疑似会战 <b>${list.length}</b>` : '暂无疑似会战'}</h3>
      <span class="text-muted kb-battle-rule">${rule}</span>
      <label class="jump-check kb-battle-notify"><input type="checkbox" data-battle-set="on"${set.on ? ' checked' : ''}><span>弹出提醒</span></label>
    </div>`;
  const cards = list.map((b) => {
    const sys = kb.systemLabel(b.system_id);
    const mins = Math.max(1, Math.round((new Date(b.end) - new Date(b.start)) / 60e3));
    const tier = battles.battleTier(b.kills);
    const sides = b.sides.map((x) => `<span class="kb-battle-side">${entityLink(x.kind, x.id, names[x.id] || partyName(x.id))}<small>击杀 ${x.kills} · 损失 ${x.losses}</small></span>`).join('');
    return `<article class="kb-battle tier-${tier.key}">
        <div class="kb-battle-main">
          <strong><span class="kb-tier-badge"><i></i>${tier.name}</span><a class="kb-link" data-location="system:${b.system_id}">${app.esc(sys.name)}</a> <b style="color:${sys.color}">${sys.secText}</b></strong>
          <span class="text-muted">${app.esc(sys.region || '')} · 持续约 ${mins} 分钟 · 最近一次 ${timeAgo(b.end)}</span>
        </div>
        <div class="kb-battle-stats"><span><b>${b.kills}</b> 艘</span><span>约 <b>${b.pilots}</b> 人</span><span><b>${app.formatISK(b.value)}</b> ISK</span></div>
        <div class="kb-battle-sides">${sides}</div>
        <div class="kb-battle-actions">
          ${b.top ? `<button class="link-btn" data-kill="${b.top.id}">最贵损失 ${app.esc(typeName(b.top.ship_type_id))} · ${app.formatISK(b.top.value)}</button>` : ''}
          <button class="btn btn-ghost" data-battle-map="${b.system_id}">在星图查看</button>
          <button class="btn btn-ghost" data-br-battle="${b.system_id}" data-start="${b.start}" data-end="${b.end}">战场统计</button>
          <button class="btn btn-ghost" data-location="system:${b.system_id}">只看这里</button>
        </div>
      </article>`;
  }).join('');
  box.innerHTML = head + (cards ? `<div class="kb-battle-list">${cards}</div>` : '');
  box.classList.toggle('is-empty', !list.length);
}

// 会战提醒「击杀记录」按钮：按星系筛选
export function filterBySystem(id) {
  setFilter('location', { kind: 'system', id, name: kb.systemLabel(id).name });
}

// ---------- 排行榜 ----------
function renderBoardControls() {
  const seg = (key, options) => `<div class="segmented" role="group">` +
    options.map(([v, label]) => `<button data-lb="${key}:${v}" class="${S.lb[key] === v ? 'active' : ''}">${label}</button>`).join('') + '</div>';
  $('kbBoardControls').innerHTML =
    seg('side', [['losses', '损失最多'], ['kills', '击杀最多']]) +
    seg('by', [['character', '人物'], ['corporation', '军团'], ['alliance', '联盟']]) +
    seg('metric', [['value', '按价值'], ['count', '按数量']]);
}

async function loadBoard() {
  const box = $('kbBoard');
  const seq = ++S.boardSeq;
  box.innerHTML = skBoard(10);
  try {
    const { side, by, metric } = S.lb;
    const data = await api(`leaderboard?days=30&side=${side}&by=${by}&metric=${metric}&limit=20`);
    for (const r of data.rows) if (r.name) S.names.set(r.id, r.name);
    if (seq !== S.boardSeq || !$('kbBoard')) return;
    box.innerHTML = data.rows.length ? '<ol class="kb-board-list">' + data.rows.map((r, n) => `
      <li><a class="kb-board-row" href="#kb/${by}/${r.id}" data-entity="${by}:${r.id}">
        <span class="kb-rank${n < 3 ? ' top' : ''}">${n + 1}</span>
        <img src="${avatar(by, r.id, 64)}" alt="" width="30" height="30" loading="lazy">
        <span class="kb-board-name">${app.esc(r.name || partyName(r.id))}</span>
        <span class="kb-board-value"><b>${metric === 'value' ? app.formatISK(r.value) : app.formatNumber(r.count)}</b>
          <small>${metric === 'value' ? r.count + ' 次' : app.formatISK(r.value) + ' ISK'}</small></span>
      </a></li>`).join('') + '</ol>' : '<p class="text-muted kb-empty">暂无数据</p>';
  } catch (error) {
    if (seq === S.boardSeq) box.innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  }
}

// ---------- 完整排行榜：#kb/rank/{side}/{by}/{metric}/{days}/{page} ----------
// 服务端分页（/leaderboard?offset=&limit=&q=），列出统计期内全部上榜的人物 / 军团 / 联盟；名称筛选在服务端全部条目里查找，排名不变
const RANK_DAYS = [[1, '24 小时'], [7, '7 天'], [30, '30 天'], [60, '60 天']];
const RANK_SIZES = [20, 50, 100];
const RANK_SIZE_KEY = 'eve-kb-rank-size';
const rankHash = (r) => `#kb/rank/${r.side}/${r.by}/${r.metric}/${r.days}${r.page > 1 ? '/' + r.page : ''}`;

function rankSize() {
  let v = 20;
  try { v = Number(localStorage.getItem(RANK_SIZE_KEY)) || 20; } catch { /* 无痕模式等 */ }
  return RANK_SIZES.includes(v) ? v : 20;
}

function parseRankHash(hash) {
  const [, side, by, metric, days, page] = /^#kb\/rank(?:\/(\w+))?(?:\/(\w+))?(?:\/(\w+))?(?:\/(\d+))?(?:\/(\d+))?/.exec(hash) || [];
  return {
    side: side === 'kills' ? 'kills' : side === 'losses' ? 'losses' : S.lb.side,
    by: KIND_ZH[by] ? by : S.lb.by,
    metric: metric === 'count' ? 'count' : metric === 'value' ? 'value' : S.lb.metric,
    days: RANK_DAYS.some(([d]) => d === Number(days)) ? Number(days) : 30,
    page: Math.max(1, Number(page) || 1)
  };
}

function renderRank(hash) {
  S.entity = null;
  const prev = S.rank;
  S.rank = { ...parseRankHash(hash), size: rankSize(), filter: prev?.filter || '', data: null, seq: (prev?.seq || 0) + 1 };
  $('kbMain').innerHTML = `
    ${BACK_LINK}
    <section class="kb-rank-page">
      <div class="kb-rank-head">
        <h2>排行榜</h2>
        <span class="text-muted" id="kbRankSub"></span>
      </div>
      <div class="kb-rank-controls" id="kbRankControls"></div>
      <div id="kbRankBody">${skCards(3)}${skRows(12)}</div>
    </section>`;
  renderRankControls();
  loadRank();
}

// 换条件 / 翻页：替换地址（不增加浏览记录），返回键直接回击杀首页
function setRank(patch) {
  const next = { ...S.rank, ...patch };
  history.replaceState(null, '', rankHash(next));
  if ('side' in patch || 'by' in patch || 'metric' in patch || 'days' in patch) { renderRank(location.hash); return; }
  Object.assign(S.rank, patch, { seq: S.rank.seq + 1 });
  document.querySelector('#kbView .kb-scroll')?.scrollTo({ top: 0 });
  $('kbRankBody').classList.add('is-loading');
  loadRank();
}

function renderRankControls() {
  const r = S.rank;
  const seg = (key, options) => `<div class="segmented" role="group">` +
    options.map(([v, label]) => `<button type="button" data-rank="${key}:${v}" class="${String(r[key]) === String(v) ? 'active' : ''}">${label}</button>`).join('') + '</div>';
  $('kbRankControls').innerHTML =
    seg('side', [['losses', '损失最多'], ['kills', '击杀最多']]) +
    seg('by', [['character', '人物'], ['corporation', '军团'], ['alliance', '联盟']]) +
    seg('metric', [['value', '按价值'], ['count', '按数量']]) +
    seg('days', RANK_DAYS) +
    `<label class="search-box kb-rank-filter"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" id="kbRankFilter" placeholder="在全部${KIND_ZH[r.by]}里查找名称" autocomplete="off" aria-label="查找名称" value="${app.esc(r.filter)}"></label>`;
  $('kbRankFilter').addEventListener('input', app.debounce((e) => {
    const v = e.target.value.trim();
    if (v.length === 1 || v === S.rank.filter) return;   // 服务端至少两个字才查
    S.rank.filter = v;
    setRank({ page: 1 });
  }, 300));
  const period = RANK_DAYS.find(([d]) => d === r.days)[1];
  $('kbRankSub').textContent = `最近 ${period} · ${r.side === 'kills' ? '击杀' : '损失'}最多的${KIND_ZH[r.by]} · ${r.metric === 'value' ? '按价值' : '按数量'}排序`;
}

async function loadRank() {
  const r = S.rank;
  const seq = r.seq;
  try {
    const q = r.filter ? '&q=' + encodeURIComponent(r.filter) : '';
    const data = await api(`leaderboard?days=${r.days}&side=${r.side}&by=${r.by}&metric=${r.metric}&offset=${(r.page - 1) * r.size}&limit=${r.size}${q}&detail=1`);
    if (S.rank?.seq !== seq) return;
    absorbNames(data.names);
    for (const row of data.rows) if (row.name) S.names.set(row.id, row.name);
    if (data.first?.name) S.names.set(data.first.id, data.first.name);
    await loadTypes(data.rows.flatMap((row) => (row.ships || []).map((x) => x.ship_type_id)));
    if (S.rank?.seq !== seq) return;
    r.data = data;
    // 页码超出（例如筛选后条目变少）时回到最后一页
    if (data.matched != null && data.rows.length === 0 && data.matched > 0 && r.page > 1) { setRank({ page: Math.ceil(data.matched / r.size) }); return; }
    renderRankTable();
  } catch (error) {
    if (S.rank?.seq === seq && $('kbRankBody')) $('kbRankBody').innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  }
}

// 效率：击毁价值 ÷ (击毁 + 损失价值)
const rankEff = (row) => (row.destroyed + row.lost ? row.destroyed / (row.destroyed + row.lost) : null);

function pagerHtml(page, pages) {
  if (pages <= 1) return '';
  const w = matchMedia('(max-width: 768px)').matches ? 1 : 2;   // 手机上当前页前后各显示 1 页
  const nums = new Set([1, pages, ...Array.from({ length: w * 2 + 1 }, (_, i) => page - w + i)].filter((n) => n >= 1 && n <= pages));
  let last = 0, items = '';
  for (const n of [...nums].sort((a, b) => a - b)) {
    if (n - last > 1) items += '<span class="kb-pager-gap">…</span>';
    items += `<button type="button" data-rank-page="${n}" class="${n === page ? 'active' : ''}"${n === page ? ' aria-current="page"' : ''}>${n}</button>`;
    last = n;
  }
  return `<nav class="kb-pager" aria-label="分页">
      <button type="button" data-rank-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="上一页">‹</button>${items}
      <button type="button" data-rank-page="${page + 1}"${page >= pages ? ' disabled' : ''} aria-label="下一页">›</button>
      <label class="kb-pager-jump">跳到 <input type="number" min="1" max="${pages}" value="${page}" data-rank-jump aria-label="跳到页码"> 页</label>
    </nav>`;
}

function renderRankTable() {
  const box = $('kbRankBody');
  const r = S.rank;
  if (!box || !r?.data) return;
  box.classList.remove('is-loading');
  const { rows, total } = r.data;
  const paged = r.data.matched != null;   // 旧版服务不支持分页，只返回前几名
  const matched = paged ? r.data.matched : rows.length;
  const pages = paged ? Math.max(1, Math.ceil(matched / r.size)) : 1;
  const detail = rows.length ? rows[0].kills != null : paged;
  const fmtIsk = app.formatISK, fmtN = app.formatNumber;
  const side = r.side === 'kills' ? '击杀' : '损失';
  const kind = KIND_ZH[r.by];
  const first = r.data.first || (rows[0] && { ...rows[0] });
  const sideTotal = r.data.side_total;
  const cards = `<div class="kb-summary-cards kb-rank-cards">
      <div class="valuation-card ${r.side === 'kills' ? 'is-buy' : 'is-sell'}"><span class="valuation-label">上榜${kind}</span>
        <strong class="valuation-value">${fmtN(paged ? r.data.entities : rows.length)}<span class="unit">个</span></strong>
        <span class="valuation-detail">${sideTotal ? `有${side}记录 · 合计 ${fmtIsk(sideTotal.value)} ISK` : `有${side}记录`}</span></div>
      ${first ? `<div class="valuation-card"><span class="valuation-label">第 1 名</span>
        <strong class="valuation-value kb-rank-first"><a class="kb-link" href="#kb/${r.by}/${first.id}" data-entity="${r.by}:${first.id}">${app.esc(first.name || partyName(first.id))}</a></strong>
        <span class="valuation-detail">${r.metric === 'value' ? fmtIsk(first.value) + ' ISK · ' + fmtN(first.count) + ' 次' : fmtN(first.count) + ' 次 · ' + fmtIsk(first.value) + ' ISK'}</span></div>` : ''}
      ${total ? `<div class="valuation-card"><span class="valuation-label">全服 · 最近 ${RANK_DAYS.find(([d]) => d === r.days)[1]}</span>
        <strong class="valuation-value">${fmtIsk(total.value)}<span class="unit">ISK</span></strong>
        <span class="valuation-detail">${fmtN(total.count)} 次击毁</span></div>` : ''}
    </div>`;
  const shipsHtml = (row) => (row.ships || []).map((x) => `<img src="${IMG(`types/${x.ship_type_id}/icon`, 32)}" alt="" width="24" height="24" loading="lazy" title="${app.esc(typeName(x.ship_type_id))} · ${fmtN(x.count)} 次">`).join('');
  const affHtml = (row) => [row.corporation_id && entityLink('corporation', row.corporation_id), row.alliance_id && entityLink('alliance', row.alliance_id)].filter(Boolean).join(' · ');
  const body = rows.map((row, i) => {
    const rank = row.rank ?? i + 1;
    const share = total?.value ? row.value / total.value : null;
    const eff = detail ? rankEff(row) : null;
    return `<tr>
      <td class="kb-rank-no"><span class="kb-rank${rank <= 3 ? ' top' : ''}">${rank}</span></td>
      <td><div class="kb-rank-who">
        <img src="${avatar(r.by, row.id, 64)}" alt="" width="32" height="32" loading="lazy">
        <span><a class="kb-link" href="#kb/${r.by}/${row.id}" data-entity="${r.by}:${row.id}">${app.esc(row.name || partyName(row.id))}</a>
          ${affHtml(row) ? `<small>${affHtml(row)}</small>` : ''}</span></div></td>
      ${detail ? `
      <td class="num"><b class="up">${fmtIsk(row.destroyed)}</b><small>${fmtN(row.kills)} 次击杀</small></td>
      <td class="num"><b class="down">${fmtIsk(row.lost)}</b><small>${fmtN(row.losses)} 次损失</small></td>
      <td class="num kb-hide-sm">${eff == null ? '—' : `<span class="kb-eff"><i style="width:${(eff * 100).toFixed(1)}%"></i></span>${(eff * 100).toFixed(1)}%`}</td>
      <td class="num kb-hide-sm">${share == null ? '—' : (share * 100).toFixed(share >= 0.001 ? 2 : 3) + '%'}</td>
      <td class="kb-rank-ships kb-hide-sm">${shipsHtml(row) || '<span class="text-muted">—</span>'}</td>` : `
      <td class="num"><b>${fmtIsk(row.value)}</b></td>
      <td class="num">${fmtN(row.count)}</td>`}
    </tr>`;
  }).join('');
  const from = (r.page - 1) * r.size + 1, to = from + rows.length - 1;
  const info = paged
    ? (matched ? `${r.filter ? `「${app.esc(r.filter)}」匹配 ${fmtN(matched)} 个 · ` : ''}第 ${fmtN(from)}–${fmtN(to)} 条，共 ${fmtN(matched)} 条` : '')
    : '击杀记录服务版本较旧，只显示前几名';
  const sizeSel = paged ? `<label class="kb-pager-size">每页 <select data-rank-size aria-label="每页条数">${RANK_SIZES.map((n) => `<option value="${n}"${n === r.size ? ' selected' : ''}>${n}</option>`).join('')}</select> 条</label>` : '';
  const bar = `<div class="kb-rank-bar"><span class="text-muted">${info}</span>${sizeSel}</div>`;
  box.innerHTML = cards + bar +
    `<div class="table-scroll kb-rank-wrap"><table class="kb-rank-table">
      <thead><tr><th class="kb-rank-no">#</th><th>${kind}</th>
        ${detail ? `<th class="num">击杀</th><th class="num">损失</th><th class="num kb-hide-sm">效率</th><th class="num kb-hide-sm">占全服</th><th class="kb-hide-sm">${r.side === 'kills' ? '常驾舰船' : '常损舰船'}</th>`
          : '<th class="num">价值</th><th class="num">次数</th>'}
      </tr></thead>
      <tbody>${body || `<tr><td colspan="7" class="text-muted kb-empty">${r.filter ? `没有名称包含「${app.esc(r.filter)}」的${kind}` : '暂无数据'}</td></tr>`}</tbody>
    </table></div>
    ${pagerHtml(r.page, pages)}
    <p class="text-muted valuation-note" title="${detail ? '每次击杀只计一次；效率 = 击毁 ÷（击毁 + 损失）；所属为最近一次出现时的军团 / 联盟。' : ''}${PRICE_NOTE}">价值为估算值</p>`;
}

// ---------- 人物 / 军团 / 联盟 ----------
async function publicInfo(kind, id) {
  try {
    return await app.fetchESI(`/${kind === 'character' ? 'characters' : kind === 'corporation' ? 'corporations' : 'alliances'}/${id}/`);
  } catch {
    return {};
  }
}

function entitySkeleton(kind) {
  return BACK_LINK + skEntityHead() +
    (kind === 'character' ? skTitle(14) + skCards(5) : '') + skTitle(18) + skCards(6) +
    skTitle(12) + skToolbar(3) + skRows(8);
}

async function renderEntity(kind, id) {
  const main = $('kbMain');
  S.entity = { kind, id, side: 'all', feed: [], cursor: null, sort: { key: 'destroyed', dir: 'desc' } };
  main.innerHTML = entitySkeleton(kind);
  let stats, info, lifetime, history;
  try {
    [stats, info, lifetime, history] = await Promise.all([
      api(`entity/${kind}/${id}?days=30`),
      publicInfo(kind, id),
      kind === 'character' ? kb.fetchZkill(`stats/characterID/${id}/`).catch(() => null) : null,
      kind === 'character' ? app.fetchESI(`/characters/${id}/corporationhistory/`).catch(() => []) : []
    ]);
  } catch (error) {
    main.innerHTML = '<p class="text-muted kb-empty">统计读取失败：' + app.esc(error.message) + '</p>';
    return;
  }
  if (S.entity?.id !== id) return;
  Object.assign(S.entity, { stats, info, lifetime });
  if (stats.name) S.names.set(id, stats.name);
  if (info.name) S.names.set(id, info.name);
  const related = [info.corporation_id, info.alliance_id, ...history.map((h) => h.corporation_id)].filter((x) => x && !S.names.has(x) && !app.officialName(x));
  if (related.length) { const named = await app.resolveNames(related); for (const [k, v] of named.names) S.names.set(k, v); }
  await loadTypes([...stats.ships_used, ...stats.ships_lost].map((s) => s.ship_type_id));
  if (S.entity?.id !== id) return;

  const name = info.name || stats.name || partyName(id);
  const eff = stats.destroyed + stats.lost ? stats.destroyed / (stats.destroyed + stats.lost) * 100 : null;
  const sub = [];
  if (kind === 'character') {
    if (info.corporation_id) sub.push(entityLink('corporation', info.corporation_id));
    if (info.alliance_id) sub.push(entityLink('alliance', info.alliance_id));
    if (info.birthday) sub.push('创建于 ' + new Date(info.birthday).toLocaleDateString('zh-CN'));
  } else {
    if (info.ticker) sub.push('[' + app.esc(info.ticker) + ']');
    if (info.member_count) sub.push(app.formatNumber(info.member_count) + ' 名成员');
    if (kind === 'corporation' && info.alliance_id) sub.push(entityLink('alliance', info.alliance_id));
    if (info.date_founded) sub.push('成立于 ' + new Date(info.date_founded).toLocaleDateString('zh-CN'));
  }

  const card = (label, value, detail, cls = '') => `<div class="valuation-card ${cls}"><span class="valuation-label">${label}</span><strong class="valuation-value">${value}</strong><span class="valuation-detail">${detail}</span></div>`;
  const isk = (v) => app.formatISK(v) + '<span class="unit">ISK</span>';
  let lifetimeCards = '';
  if (kind === 'character' && lifetime && lifetime.shipsDestroyed !== undefined) {
    const lEff = (lifetime.iskDestroyed || 0) + (lifetime.iskLost || 0) ? lifetime.iskDestroyed / (lifetime.iskDestroyed + lifetime.iskLost) * 100 : null;
    lifetimeCards = `<h4 class="info-section-title">生涯统计<small>（zKillboard 估值）</small></h4><div class="valuation-grid">
      ${card('参与击杀', app.formatNumber(lifetime.shipsDestroyed || 0) + '<span class="unit">艘</span>', '单刷 ' + app.formatNumber(lifetime.soloKills || 0) + ' 次', 'is-buy')}
      ${card('损失', app.formatNumber(lifetime.shipsLost || 0) + '<span class="unit">艘</span>', '单刷被杀 ' + app.formatNumber(lifetime.soloLosses || 0) + ' 次', 'is-sell')}
      ${card('击毁价值', isk(lifetime.iskDestroyed || 0), '生涯累计', 'is-buy')}
      ${card('损失价值', isk(lifetime.iskLost || 0), '生涯累计', 'is-sell')}
      ${card('ISK 效率', lEff == null ? '—' : lEff.toFixed(1) + '%', '危险度 ' + (lifetime.dangerRatio ?? '—') + '% · 团战 ' + (lifetime.gangRatio ?? '—') + '%', 'is-total')}
    </div>`;
  }
  const recentCards = `<h4 class="info-section-title${lifetimeCards ? ' section-gap' : ''}">最近 30 天<small>（吉他中间价估值）</small></h4><div class="valuation-grid">
      ${card('参与击杀', app.formatNumber(stats.kills) + '<span class="unit">次</span>', '单刷 ' + app.formatNumber(stats.solo_kills) + ' 次', 'is-buy')}
      ${stats.final_blows != null ? card('最后一击', app.formatNumber(stats.final_blows) + '<span class="unit">次</span>', stats.kills ? '占参与击杀 ' + (stats.final_blows / stats.kills * 100).toFixed(0) + '%' : '', 'is-buy') : ''}
      ${card('损失', app.formatNumber(stats.losses) + '<span class="unit">次</span>', '', 'is-sell')}
      ${card('击毁总价值', isk(stats.destroyed), kind === 'character' ? '参与的击杀' : '成员参与的击杀（每次只计一次）', 'is-buy')}
      ${card('损失总价值', isk(stats.lost), '', 'is-sell')}
      ${card('ISK 效率', eff == null ? '—' : eff.toFixed(1) + '%', '击毁 ÷（击毁 + 损失）', 'is-total')}
    </div>`;

  const shipList = (list, title) => list.length ? `<section class="kb-mini-panel"><h5>${title}</h5>${list.map((s) =>
    `<div class="kb-mini-row"><img src="${IMG(`types/${s.ship_type_id}/icon`, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(typeName(s.ship_type_id))}</span><b>${s.count}</b></div>`).join('')}</section>` : '';
  const activity = activityHtml(stats);
  const corpHistory = kind === 'character' ? corpHistoryHtml(history) : '';

  main.innerHTML = `
    ${BACK_LINK}
    <div class="kb-entity-head">
      <img src="${avatar(kind, id, 128)}" alt="" width="72" height="72">
      <div>
        <span class="kb-entity-kind">${KIND_ZH[kind]}</span>
        <h2>${app.esc(name)}</h2>
        <p>${sub.join(' · ')}</p>
      </div>
      <a class="btn btn-ghost" href="https://zkillboard.com/${kind}/${id}/" target="_blank" rel="noopener">zKillboard ↗</a>
    </div>
    ${lifetimeCards}${recentCards}
    ${stats.members ? `<h4 class="info-section-title section-gap">${kind === 'alliance' ? '成员军团' : '成员'}<small>（最近 30 天 · 点击表头排序）</small></h4><div id="kbMembers"></div>` : ''}
    ${activity}${corpHistory}
    <div class="kb-mini-grid">${shipList(stats.ships_used, '常用舰船（击杀时）')}${shipList(stats.ships_lost, '损失的舰船')}</div>
    <div class="kb-feed-head section-gap">
      <h4 class="info-section-title">击杀记录</h4>
      <div class="segmented" role="group">
        ${[['all', '全部'], ['kills', '击杀'], ['losses', '损失']].map(([v, l]) => `<button data-entity-side="${v}" class="${v === 'all' ? 'active' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div id="kbEntityFeed">${skRows(8)}</div>
    <button class="btn kb-more" id="kbEntityMore" hidden>加载更多</button>`;
  if (stats.members) renderMembers();
  $('kbEntityMore').addEventListener('click', () => loadEntityFeed(false));
  loadEntityFeed(true);
}

// 最近 30 天活跃地区：星域（占比条）+ 星系（安全等级着色），点击可筛选击杀记录
function activityHtml(stats) {
  const regions = stats.regions || [], systems = stats.systems || [];
  if (!regions.length && !systems.length) return '';
  const total = regions.reduce((s, r) => s + r.count, 0) || 1;
  const regionRows = regions.map((r) => {
    const pct = r.count / total * 100;
    return `<div class="kb-share-row">
        <span class="kb-share-name"><a class="kb-link" data-location="region:${r.region_id}">${app.esc(partyName(r.region_id))}</a></span>
        <span class="kb-share-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <b>${app.formatNumber(r.count)}</b><small>${pct.toFixed(0)}%</small>
      </div>`;
  }).join('');
  const systemRows = systems.map((x) => {
    const sys = kb.systemLabel(x.system_id);
    return `<div class="kb-mini-row"><span><a class="kb-link" data-location="system:${x.system_id}">${app.esc(sys.name)}</a>
        <b style="color:${sys.color}">${sys.secText}</b>${sys.region ? ` <small>${app.esc(sys.region)}</small>` : ''}</span><b>${app.formatNumber(x.count)}</b></div>`;
  }).join('');
  return `<h4 class="info-section-title section-gap">最近 30 天活跃地区<small>（击杀与损失次数 · 点击筛选记录）</small></h4>
    <div class="kb-activity">
      ${regionRows ? `<section class="kb-mini-panel"><h5>星域</h5>${regionRows}</section>` : ''}
      ${systemRows ? `<section class="kb-mini-panel"><h5>星系</h5>${systemRows}</section>` : ''}
    </div>`;
}

// 历史军团：ESI 公开的人物军团履历（最新在前）
function corpHistoryHtml(history) {
  if (!history?.length) return '';
  const list = [...history].sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
  const day = (d) => new Date(d).toLocaleDateString('zh-CN');
  const span = (from, to) => {
    const days = Math.max(0, Math.round((to - from) / 86400e3));
    if (days < 1) return '不到 1 天';
    if (days < 60) return days + ' 天';
    if (days < 730) return Math.round(days / 30.4) + ' 个月';
    return (days / 365.25).toFixed(1) + ' 年';
  };
  const rows = list.map((h, i) => {
    const from = new Date(h.start_date), to = i ? new Date(list[i - 1].start_date) : new Date();
    const npc = h.corporation_id >= 1000000 && h.corporation_id < 2000000;
    const name = npc ? app.esc(partyName(h.corporation_id)) : entityLink('corporation', h.corporation_id);
    return `<div class="kb-history-row${i ? '' : ' current'}">
        <img src="${avatar('corporation', h.corporation_id, 32)}" alt="" width="28" height="28" loading="lazy">
        <span class="kb-history-name"><strong>${name}</strong>${npc ? '<span class="kb-tag npc">NPC</span>' : ''}${h.is_deleted ? '<span class="kb-tag">已解散</span>' : ''}</span>
        <span class="kb-history-date">${day(from)} — ${i ? day(to) : '至今'}</span>
        <b>${span(from, to)}</b>
      </div>`;
  }).join('');
  return `<h4 class="info-section-title section-gap">历史军团<small>（共 ${list.length} 段）</small></h4>
    <section class="kb-mini-panel kb-history">${rows}</section>`;
}

const MEMBER_COLS = [['name', '名称'], ['kills', '击杀'], ['destroyed', '击毁价值'], ['losses', '损失'], ['lost', '损失价值'], ['eff', 'ISK 效率']];

function renderMembers() {
  const e = S.entity;
  const memberKind = e.kind === 'alliance' ? 'corporation' : 'character';
  const rows = e.stats.members.map((m) => ({ ...m, name: m.name || partyName(m.id), eff: m.destroyed + m.lost ? m.destroyed / (m.destroyed + m.lost) : -1 }));
  const { key, dir } = e.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    const cmp = typeof x === 'string' ? x.localeCompare(y, 'zh-CN') : x - y;
    return dir === 'asc' ? cmp : -cmp;
  });
  $('kbMembers').innerHTML = `<div class="table-scroll"><table class="pc-mini-table kb-members"><thead><tr>
      ${MEMBER_COLS.map(([k, label]) => `<th class="sortable${k === key ? ' sorted' : ''}${k === 'name' ? '' : ' num'}" data-sort="${k}" data-dir="${k === key ? dir : ''}" tabindex="0">${label}</th>`).join('')}
    </tr></thead><tbody>${rows.map((m) => `<tr>
      <td><span class="kb-member"><img src="${avatar(memberKind, m.id, 32)}" alt="" width="22" height="22" loading="lazy">${entityLink(memberKind, m.id, m.name)}</span></td>
      <td class="num">${app.formatNumber(m.kills)}</td>
      <td class="num up">${app.formatISK(m.destroyed)}</td>
      <td class="num">${app.formatNumber(m.losses)}</td>
      <td class="num down">${app.formatISK(m.lost)}</td>
      <td class="num">${m.eff < 0 ? '—' : (m.eff * 100).toFixed(1) + '%'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// 加载更多期间重复点击会被忽略；切换全部 / 击杀 / 损失时旧请求作废
async function loadEntityFeed(reset) {
  const e = S.entity;
  if (!e || (!reset && e.busy)) return;
  const seq = e.seq = (e.seq || 0) + 1;
  e.busy = true;
  const box = $('kbEntityFeed');
  if (reset) { e.feed = []; e.cursor = null; box.innerHTML = skRows(10); }
  const q = new URLSearchParams({ [e.kind]: e.id, side: e.side, limit: 50 });
  if (e.cursor) q.set('cursor', e.cursor);
  setMoreBusy($('kbEntityMore'), true, e.cursor);
  try {
    const data = await api('feed?' + q);
    absorbNames(data.names);
    await loadTypes(typesOf(data.kills));
    if (S.entity !== e || seq !== e.seq) return;
    e.feed = e.feed.concat(data.kills);
    e.cursor = data.cursor;
    const key = { character: 'character_id', corporation: 'corporation_id', alliance: 'alliance_id' }[e.kind];
    box.innerHTML = feedTable(e.feed, { me: { key, id: e.id }, notice: data.notice });
    $('kbEntityMore').hidden = !e.cursor;
  } catch (error) {
    if (S.entity === e && seq === e.seq) box.innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  } finally {
    if (seq === e.seq) {
      e.busy = false;
      setMoreBusy($('kbEntityMore'), false);
    }
  }
}

// ---------- 搜索：人物 / 军团 / 联盟（服务端）+ 舰船 / 星系 / 星域（本地）----------
let searchSeq = 0;
async function runSearch(text) {
  const box = $('kbSuggest');
  const q = text.trim().toLowerCase();
  if (q.length < 2) { box.hidden = true; return; }
  const seq = ++searchSeq;
  const local = localSearch(q);
  renderSuggest({ ...local, entities: null });
  let entities = [];
  try { entities = (await api('search?q=' + encodeURIComponent(q))).results; } catch { /* 服务不可用时只显示本地结果 */ }
  if (seq !== searchSeq) return;
  renderSuggest({ ...local, entities });
}

function localSearch(q) {
  const score = (name) => { const l = name.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : -1; };
  const pick = (list, n) => list.map((x) => ({ ...x, s: score(x.name) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length).slice(0, n);
  const npc = app.getNpcNames();
  const systems = npc ? Object.entries(npc.systems).map(([id, name]) => ({ id: Number(id), name })) : [];
  const regions = npc ? Object.entries(npc.regions).map(([id, name]) => ({ id: Number(id), name })) : [];
  return { ships: pick(app.shipTypes(), 6), systems: pick(systems, 6), regions: pick(regions, 4) };
}

function renderSuggest({ entities, ships, systems, regions }) {
  const box = $('kbSuggest');
  const group = (title, items) => items.length ? `<div class="kb-suggest-group">${title}</div>` + items.join('') : '';
  const ents = entities || [];
  const byKind = (kind) => ents.filter((e) => e.category === kind).slice(0, 6).map((e) =>
    `<button class="kb-suggest-item" data-pick-entity="${kind}:${e.id}"><img src="${avatar(kind, e.id, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(e.name)}</span><small>${KIND_ZH[kind]}统计</small></button>`);
  const html =
    (entities === null ? '<div class="kb-suggest-group">人物 / 军团 / 联盟 · 搜索中…</div>' :
      group('人物', byKind('character')) + group('军团', byKind('corporation')) + group('联盟', byKind('alliance'))) +
    group('舰船', ships.map((s) => `<button class="kb-suggest-item" data-pick-ship="${s.id}"><img src="${IMG(`types/${s.id}/icon`, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(s.name)}</span><small>筛选击杀记录</small></button>`)) +
    group('星系', systems.map((s) => { const l = kb.systemLabel(s.id); return `<button class="kb-suggest-item" data-pick-location="system:${s.id}"><i style="background:${l.color}"></i><span>${app.esc(s.name)} <b style="color:${l.color}">${l.secText}</b></span><small>${app.esc(l.region)}</small></button>`; })) +
    group('星域', regions.map((r) => `<button class="kb-suggest-item" data-pick-location="region:${r.id}"><i></i><span>${app.esc(r.name)}</span><small>星域</small></button>`));
  box.innerHTML = html || '<p class="legend-empty">没有找到匹配项</p>';
  box.hidden = false;
}

// ---------- 路由：#kb、#kb/character/ID、#kb/corporation/ID、#kb/alliance/ID、#kb/br… ----------
function navigate(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
  route();
}

let routed = false;
function route() {
  routed = true;
  const m = /^#kb\/(character|corporation|alliance)\/(\d+)/.exec(location.hash);
  $('kbSuggest').hidden = true;
  document.querySelector('#kbView .kb-scroll')?.scrollTo({ top: 0 });
  if (location.hash.startsWith('#kb/br')) { S.entity = null; renderBr(location.hash); }
  else if (location.hash.startsWith('#kb/rank')) renderRank(location.hash);
  else if (m) renderEntity(m[1], Number(m[2]));
  else renderHome();
}

// ---------- 入口 ----------
let started = false;

function homeSkeleton() {
  return `<section class="kb-summary">${skSummary()}</section>
    <section class="kb-section">${skTitle(14)}<div class="kb-top">${skTopCards(10)}</div></section>
    <div class="kb-columns"><section class="kb-section kb-feed-panel">${skTitle(16)}${skRows(10)}</section>
      <aside class="kb-section kb-board">${skTitle(30)}${skBoard(10)}</aside></div>`;
}

let ready = null;
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      kb = await app.loadKillboard();
      await kb.ensureSystems();
    })().catch((error) => { ready = null; throw error; });
  }
  return ready;
}

// 空闲时预取：模块与星系数据、首页的统计 / 最高损失 / 最新击杀 / 默认排行榜，以及需要的名称
export async function prefetchKbHome() {
  await ensureReady();
  const paths = ['summary?hours=24', 'status', 'top?days=7&limit=10', 'feed?' + feedQuery(),
    `leaderboard?days=30&side=${S.lb.side}&by=${S.lb.by}&metric=${S.lb.metric}&limit=20`];
  const at = Date.now();
  const jobs = paths.map((path) => {
    const promise = request(path);
    promise.catch(() => {});
    prefetched.set(path, { at, promise });
    return promise;
  });
  const [, , top, feed] = await Promise.all(jobs);
  absorbNames(top.names);
  absorbNames(feed.names);
  await loadTypes([...top.kills.map((k) => k.ship_type_id), ...typesOf(feed.kills)]);
}

// restored：从其他页面切回且地址未变，保留当前页面（滚动位置、筛选、展开状态）
export async function showKbPage(restored = false) {
  if (!started) {
    started = true;
    const entity = /^#kb\/(character|corporation|alliance)\//.exec(location.hash);
    if (!$('kbMain').children.length) $('kbMain').innerHTML = entity ? entitySkeleton(entity[1]) : homeSkeleton();
  }
  await ensureReady();
  if (!location.hash.startsWith('#kb')) history.replaceState(null, '', '#kb');
  if (restored && routed) return;
  route();
}

export function initKbPage(context) {
  app = context;
  initBr({
    get app() { return app; }, get kb() { return kb; },
    request, absorbNames, partyName, typeName, loadTypes, avatar, entityLink, IMG
  });
  app.battles()?.then((m) => {
    if (!m) return;
    battles = m;
    m.onBattles(async (list) => {
      await loadTypes(list.map((b) => b.top?.ship_type_id).filter(Boolean));
      renderBattles();
    });
  });
  $('kbView').addEventListener('change', (e) => {
    const el = e.target.closest('[data-battle-set]');
    if (!el || !battles) return;
    const key = el.dataset.battleSet;
    if (key === 'on') battles.setBattleSettings({ on: el.checked });
  });
  const input = $('kbSearch');
  input.addEventListener('input', app.debounce(() => runSearch(input.value), 200));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; $('kbSuggest').hidden = true; }
    if (e.key === 'Enter') { $('kbSuggest').querySelector('.kb-suggest-item')?.click(); e.preventDefault(); }
  });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) runSearch(input.value); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.kb-search')) $('kbSuggest').hidden = true; });

  $('kbView').addEventListener('click', (e) => {
    const entity = e.target.closest('[data-entity], [data-pick-entity]');
    if (entity) {
      e.preventDefault();
      const [kind, id] = (entity.dataset.entity || entity.dataset.pickEntity).split(':');
      input.value = '';
      navigate(`#kb/${kind}/${id}`);
      return;
    }
    if (e.target.closest('[data-kb-br]')) { navigate('#kb/br'); return; }
    if (e.target.closest('[data-kb-rank]')) { e.preventDefault(); navigate(rankHash({ ...S.lb, days: 30 })); return; }
    const rk = e.target.closest('[data-rank]');
    if (rk && S.rank) {
      const [key, value] = rk.dataset.rank.split(':');
      setRank({ [key]: key === 'days' ? Number(value) : value, page: 1 });
      return;
    }
    const pg = e.target.closest('[data-rank-page]');
    if (pg && S.rank && !pg.disabled) { setRank({ page: Number(pg.dataset.rankPage) }); return; }
    const brBattle = e.target.closest('[data-br-battle]');
    if (brBattle) {
      // 会战卡片：以会战星系与持续时间（前后各留 10 分钟）打开战场统计
      const { brBattle: sys, start, end } = brBattle.dataset;
      const t0 = Math.floor(new Date(start).getTime() / 1000 / 60) * 60 - 600;
      const t1 = Math.min(Math.ceil(new Date(end).getTime() / 1000 / 60) * 60 + 600, Math.ceil(Date.now() / 1000 / 60) * 60);
      navigate(`#kb/br/${sys}/${t0}-${t1}`);
      return;
    }
    const battleMap = e.target.closest('[data-battle-map]');
    if (battleMap) { app.openMapSystem(Number(battleMap.dataset.battleMap)); return; }
    const loc = e.target.closest('[data-location], [data-pick-location]');
    if (loc) {
      e.preventDefault();
      const [kind, id] = (loc.dataset.location || loc.dataset.pickLocation).split(':');
      const name = kind === 'system' ? kb.systemLabel(Number(id)).name : partyName(Number(id));
      input.value = '';
      $('kbSuggest').hidden = true;
      setFilter('location', { kind, id: Number(id), name });
      return;
    }
    const ship = e.target.closest('[data-pick-ship]');
    if (ship) {
      const id = Number(ship.dataset.pickShip);
      input.value = '';
      $('kbSuggest').hidden = true;
      setFilter('ship', { id, name: app.shipTypes().find((s) => s.id === id)?.name || typeName(id) });
      return;
    }
    const clear = e.target.closest('[data-clear-filter]');
    if (clear) { setFilter(clear.dataset.clearFilter, null); return; }
    if (e.target.closest('[data-kb-home]')) { e.preventDefault(); navigate('#kb'); return; }
    const lb = e.target.closest('[data-lb]');
    if (lb) {
      const [key, value] = lb.dataset.lb.split(':');
      S.lb[key] = value;
      renderBoardControls();
      loadBoard();
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort && S.entity) {
      const key = sort.dataset.sort;
      const cur = S.entity.sort;
      S.entity.sort = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      renderMembers();
      return;
    }
    const side = e.target.closest('[data-entity-side]');
    if (side && S.entity) {
      S.entity.side = side.dataset.entitySide;
      side.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === side));
      loadEntityFeed(true);
      return;
    }
    const kill = e.target.closest('[data-kill]');
    if (kill) openKill(Number(kill.dataset.kill));
  });
  $('kbView').addEventListener('change', (e) => {
    if (!S.rank) return;
    if (e.target.matches('[data-rank-size]')) {
      const size = Number(e.target.value);
      try { localStorage.setItem(RANK_SIZE_KEY, String(size)); } catch { /* 无痕模式等 */ }
      // 保持当前页第一条仍在视野内
      setRank({ size, page: Math.floor(((S.rank.page - 1) * S.rank.size) / size) + 1 });
    } else if (e.target.matches('[data-rank-jump]')) {
      const pages = Math.max(1, Math.ceil((S.rank.data?.matched || 0) / S.rank.size));
      setRank({ page: Math.min(pages, Math.max(1, Number(e.target.value) || 1)) });
    }
  });
  $('kbView').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.kb-row')) openKill(Number(e.target.dataset.kill));
  });
  window.addEventListener('popstate', () => { if (!$('kbView').hidden && location.hash.startsWith('#kb')) route(); });
}
