// ===== 击杀记录页 =====
// 数据来自自建的击杀记录服务（server/kb_service.py，/api/kb/），收录新伊甸全部击杀；
// 所有价值按吉他海4 最低卖价与最高收购价的中间值估算。人物的生涯统计来自 zKillboard。
// 国服（晨曦 / 曙光）：同一服务按 server= 分库，数据来自 CEVE 市场 KM 广播，从接入起累计；没有 zKillboard，按各服主贸易中心估值。
import { skCards, skRows, skTopCards, skBoard, skSummary, skEntityHead, skTitle, skToolbar } from './skeleton.js?v=v17';
import { initBr, renderBr } from './kb-br.js?v=v48';
import { gankSystemHtml, GANK_NOTE } from './kb-gank.js?v=v1';
import { initKbCharts, hoursChart, drawHours, monthsChart, drawMonths, heatChart, drawHeat } from './kb-charts.js?v=v3';
import { exportCsv, exportBtnHtml } from './csv-export.js?v=2';
import { SERVER, IS_TQ, HUB, eveImage, kbSiteLink } from './server.js?v=s4';
import * as ST from './standings.js?v=v6';
import { fullIn } from './eve-time.js?v=v1';

let app, kb;

const API = '/api/kb/';
const IMG = (path, size) => eveImage(path, size);   // 国服人物头像、军团 / 联盟图标在网易图片服务器
const SRV = IS_TQ ? '' : 'server=' + SERVER.id;
const VALUE_LABEL = IS_TQ ? '吉他中间价估值' : `${HUB.hub.name} 中间价估值`;
const CN_PRICE_NOTE = `单项与总价值按${HUB.hub.name} 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取${SERVER.full}全服均价）。`;
const PRICE_NOTE = !IS_TQ ? CN_PRICE_NOTE : '单项与总价值按吉他海4 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取全服均价）；旗舰等吉他没有卖单的物品，按全服公开合同扣除附带物品后的最低价估算。';
const KIND_ZH = { character: '人物', corporation: '军团', alliance: '联盟' };
// 子页面顶部的返回按钮，与战场统计页同款
// 返回按钮：本次在击杀页里是从别的页（人物 / 军团 / 联盟、排行、会战…）点进来的，就退回上一页（浏览器后退，滚动位置等由各页自己处理）；
// 直接打开链接进来的才回击杀记录首页。trail 是本次在击杀页里走过的地址，trailNames 记人物 / 军团 / 联盟页的名字，按钮上显示「返回 某某」
const trail = [];
const trailNames = new Map();
function backLink() {
  const prev = trail.length > 1 ? trail[trail.length - 2] : null;
  const label = !prev || prev === '#kb' ? '返回击杀记录' : trailNames.has(prev) ? '返回 ' + trailNames.get(prev) : '返回上一页';
  return `<a class="btn kb-br-back kb-back-btn" href="${prev ? app.esc(prev) : '#kb'}" data-kb-home><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span>${app.esc(label)}</span></a>`;
}
// 当前页在首页下面第几层：trail 里最后一个 #kb 之后有几页（直接打开链接进来、没经过首页的，从第一页算起）
function depth() {
  const k = trail.lastIndexOf('#kb');
  return trail.length - (k + 1);
}
function noteTrail() {
  const h = location.hash || '#kb';
  if (trail[trail.length - 1] === h) return;
  if (trail[trail.length - 2] === h) trail.pop();   // 后退回来的
  else trail.push(h);
  if (trail.length > 50) trail.splice(0, trail.length - 50);
  // 从击杀首页往里点了 3 层及以上（首页 → A → B → C）：右下角「回到顶部」上面多一个回首页的图标按钮（to-top.js）
  window.toTopHome?.(depth() >= 3 ? () => navigate('#kb') : null, '#kb', '回到击杀记录首页');
}

const S = {
  names: new Map(),          // 玩家角色 / 军团 / 联盟原名
  types: new Map(),
  filters: { ships: [], locs: [], ents: [] },   // 首页击杀列表筛选，可多选：舰船 { id, name }、地点 { kind, id, name }、人物 / 军团 / 联盟 { kind, id, name }
  fine: { min: 0, space: '', solo: false, npc: false, gank: false },   // 细筛选：最低价值、空间、单刷、排除 NPC 击杀、疑似强爆（只查本站收录）
  gank: { days: 30, seq: 0 },   // 高安强爆面板：统计天数、请求序号（只渲染最新一次）
  feed: [], cursor: null, feedSeq: 0, boardSeq: 0,
  lb: { side: 'losses', by: 'character', metric: 'value' },
  rank: null,                // 完整排行榜：{ side, by, metric, days, sort, filter, data, seq }
  bh: null,                  // 近 30 天会战：{ days, size, sec, region, q, sort, shown, data }
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
  const res = await fetch(API + path + (SRV ? (path.includes('?') ? '&' : '?') + SRV : ''));
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

// 列表里角色名下面的军团 / 联盟：前面带 14px 的徽标
const orgLink = (kind, id) => `<img class="kb-org-ic" src="${avatar(kind, id, 32)}" alt="" width="14" height="14" loading="lazy">${entityLink(kind, id)}`;
function avatar(kind, id, size = 32) {
  if (!id) return '';
  const path = kind === 'character' ? `characters/${id}/portrait` : kind === 'alliance' ? `alliances/${id}/logo` : `corporations/${id}/logo`;
  return IMG(path, size);
}

// 声望小标（已绑定角色的联系人，standings.js）：p 带 character_id / corporation_id / alliance_id
const stOf = (p) => ST.badge({ char: p?.character_id, corp: p?.corporation_id, alliance: p?.alliance_id });
// 排行、实体页：只有一个 ID 与种类
const stKind = (kind, id) => ST.badge({ [{ character: 'char', corporation: 'corp', alliance: 'alliance' }[kind] || 'x']: Number(id) });

function entityLink(kind, id, text) {
  if (!id) return '';
  return `<a class="kb-link" href="#kb/${kind}/${id}" data-entity="${kind}:${id}" translate="no">${app.esc(text || partyName(id))}</a>`;
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
    // 宁静服本站只保留 --days 天（默认半年），更早的记录是实时向 zKillboard 查询的（不入库），用分隔行标出
    const divider = k.archive && !divided
      ? (divided = true, `<tr class="kb-divider"><td colspan="${me ? 6 : 5}">以下为 ${keptDays()} 天前的记录（zKillboard）</td></tr>`)
      : '';
    const sys = kb.systemLabel(k.system_id);
    const side = me ? (v[me.key] === me.id ? 'loss' : 'kill') : null;
    return `${divider}<tr class="kb-row" data-kill="${k.id}" tabindex="0">
        ${side ? `<td class="kb-side"><span class="pill ${side === 'loss' ? 'sell' : 'buy'}">${side === 'loss' ? '损失' : '击杀'}</span></td>` : ''}
        <td class="kb-ship"><span class="kb-ship-inner"><img src="${IMG(`types/${k.ship_type_id}/icon`, 64)}" alt="" width="32" height="32" loading="lazy">
          <span><strong>${app.esc(typeName(k.ship_type_id))}</strong>${k.solo ? '<span class="kb-tag solo">单刷</span>' : ''}${k.npc ? '<span class="kb-tag npc">NPC</span>' : ''}</span></span></td>
        <td class="kb-party kb-victim-cell"><strong>${stOf(v)}${v.character_id ? entityLink('character', v.character_id) : entityLink('corporation', v.corporation_id)}</strong>
          <span class="cell-sub">${v.character_id ? orgLink('corporation', v.corporation_id) : ''}${v.alliance_id ? (v.character_id ? ' · ' : '') + orgLink('alliance', v.alliance_id) : ''}</span></td>
        <td class="kb-party kb-final-cell"><strong>${stOf(f)}${f.character_id ? entityLink('character', f.character_id) : app.esc(typeName(f.ship_type_id))}</strong>
          <span class="cell-sub">${f.corporation_id && f.character_id ? orgLink('corporation', f.corporation_id) + ' · ' : ''}${f.alliance_id && f.character_id ? orgLink('alliance', f.alliance_id) + ' · ' : ''}${k.attackers} 名攻击者</span></td>
        <td class="kb-loc"><strong><a class="kb-link" data-location="system:${k.system_id}">${app.esc(sys.name)}</a> <span style="color:${sys.color}">${sys.secText}</span></strong>
          <span class="cell-sub">${k.region_id ? `<a class="kb-link" data-location="region:${k.region_id}">${app.esc(partyName(k.region_id))}</a>` : ''}</span></td>
        <td class="num kb-value"><strong>${app.formatISK(k.value)}</strong><span class="cell-sub">${timeAgo(k.time)}</span></td>
      </tr>`;
  }).join('');
}

// 本站保留天数（status 的 retention_days 比 --days 多 1 天余量）；国服永久保存，从接入那天起收录
const keptDays = () => (S.status?.retention_days || 181) - 1;
const FEED_NOTICE = {
  get global_end() {
    if (IS_TQ) return fineOn() ? `价值 / 空间 / 单刷 / NPC 筛选只查本站最近 ${keptDays()} 天` : `仅存 ${keptDays()} 天，加舰船或地点筛选可查更早`;
    return S.status?.since ? `${SERVER.full}从 ${new Date(S.status.since).toLocaleDateString('zh-CN')} 起收录，没有更早的记录` : '没有更早的记录';
  },
  zkill_limit: 'zKillboard 最多查 2 万条，请缩小范围'
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
  // 从人物 / 军团 / 联盟页点进来：攻击者里属于它的行高亮
  const focus = S.entity && ['character', 'corporation', 'alliance'].includes(S.entity.kind) ? { kind: S.entity.kind, id: Number(S.entity.id) } : null;
  kb.openKill(null, {
    focus,
    priceNote: !IS_TQ ? CN_PRICE_NOTE : '总价值、掉落与摧毁价值按吉他海4 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取全服均价；旗舰等吉他没有卖单的物品按全服公开合同最低价）。',
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
            valueLabel: VALUE_LABEL
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
      <div class="kb-top" id="kbTop">${skTopCards(14)}</div>
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
        <div class="kb-fine" id="kbFine"></div>
        <div id="kbGank" hidden></div>
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
  startLive();
  $('kbMore').addEventListener('click', () => loadFeed(false));
  renderFilters();
  renderFine();
  renderBoardControls();
  renderBattles();
  loadGank();
  await Promise.all([loadSummary(), loadTop(), loadFeed(true), loadBoard()]);
}

async function loadSummary() {
  const box = $('kbSummary');
  try {
    const [day, status] = await Promise.all([api('summary?hours=24'), api('status')]);
    S.status = status;
    renderStatus();
    if (!$('kbSummary')) return;
    box.innerHTML = `
      <div class="kb-summary-cards">
        <div class="valuation-card is-sell"><span class="valuation-label">最近 24 小时总损失</span>
          <strong class="valuation-value">${app.formatISK(day.value)}<span class="unit">ISK</span></strong>
          <span class="valuation-detail">${VALUE_LABEL}</span></div>
        <div class="valuation-card"><span class="valuation-label">击毁舰船</span>
          <strong class="valuation-value">${app.formatNumber(day.count - day.pods)}<span class="unit">艘</span></strong>
          <span class="valuation-detail">另有 ${app.formatNumber(day.pods)} 个太空舱</span></div>
        <div class="valuation-card is-order"><span class="valuation-label">损失最多的星域</span>
          <strong class="valuation-value kb-region-value">${day.regions[0] ? `<a class="kb-link" data-location="region:${day.regions[0].region_id}">${app.esc(partyName(day.regions[0].region_id))}</a>` : '—'}</strong>
          <span class="valuation-detail">${day.regions[0] ? app.formatISK(day.regions[0].value) + ' ISK · ' + day.regions[0].count + ' 次' : ''}</span></div>
      </div>
      ${hoursChart(day.buckets)}`;
    drawHours(box, day.buckets);
  } catch (error) {
    box.innerHTML = '<p class="text-muted kb-empty">统计读取失败：' + app.esc(error.message) + '</p>';
  }
}

function renderStatus() {
  const st = S.status;
  if (!st || !$('kbStatus')) return;
  const live = { poll: '轮询 zKillboard', redisq: 'zKillboard 实时推送', kmqueue: 'CEVE 市场 KM 广播', off: '未开启' }[st.live_mode] || '启动中';
  // 国服没有历史存档：从本站接入那天起累计，注明起点并给出外部击坠榜
  const since = !IS_TQ && st.since ? ` · <span>${SERVER.full}从 ${new Date(st.since).toLocaleDateString('zh-CN')} 起收录</span>` : '';
  const site = !IS_TQ && SERVER.kbSite ? ` · <a href="${SERVER.kbSite.url}/" target="_blank" rel="noopener">${app.esc(SERVER.kbSite.name)} ↗</a>` : '';
  $('kbStatus').innerHTML = `收录 <b>${app.formatNumber(st.killmails)}</b> 条 · ${st.oldest ? new Date(st.oldest).toLocaleDateString('zh-CN') : '—'} 至 ${st.newest ? timeAgo(st.newest) : '—'}
    · <span>实时：${live}</span>${st.backfill && st.backfill !== '完成' ? ' · 历史：' + app.esc(st.backfill) : ''}${since}${site}`;
}

async function loadTop() {
  const box = $('kbTop');
  try {
    const data = await api('top?days=7&limit=14');
    absorbNames(data.names);
    await loadTypes(data.kills.map((k) => k.ship_type_id));
    if (!$('kbTop')) return;
    box.innerHTML = data.kills.map((k) => `
      <button class="kb-top-card" data-kill="${k.id}">
        <img src="${IMG(`types/${k.ship_type_id}/render`, document.documentElement.dataset.skin === 'eve' ? 256 : 128)}" alt="" width="72" height="72" loading="lazy">
        <span class="kb-top-text">
          <strong>${app.esc(typeName(k.ship_type_id))}</strong>
          <small translate="no">${stOf(k.victim)}${app.esc(partyName(k.victim.character_id) || partyName(k.victim.corporation_id))}</small>
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
  const f0 = S.filters;
  // 同一类多选之间是「或」：几种船、几个地点、几个人里任一个；不同类之间是「且」
  const put = (key, list) => { if (list.length) q.set(key, list.map((x) => x.id).join(',')); };
  put('ship', f0.ships);
  for (const k of ['system', 'constellation', 'region']) put(k, f0.locs.filter((x) => x.kind === k));
  for (const k of ['character', 'corporation', 'alliance']) put(k, f0.ents.filter((x) => x.kind === k));
  const f = S.fine;
  if (f.min) q.set('min', f.min);
  if (f.space) q.set('space', f.space);
  if (f.solo) q.set('solo', 1);
  if (f.npc) q.set('npc', 0);
  if (f.gank) q.set('gank', 1);
  return q;
}
const fineOn = () => !!(S.fine.min || S.fine.space || S.fine.solo || S.fine.npc || S.fine.gank);

// 细筛选条：价值门槛、空间类型、单刷、排除 NPC 击杀
const FINE_MIN = [[0, '不限'], [1e7, '1000万+'], [1e8, '1亿+'], [1e9, '10亿+'], [1e10, '100亿+']];
const FINE_SPACE = [['', '全部'], ['k', 'K 空间'], ['wh', '虫洞'], ['abyss', '深渊']];
function renderFine() {
  const box = $('kbFine');
  if (!box) return;
  const f = S.fine;
  const seg = (key, opts) => opts.map(([v, l]) => `<button type="button" data-fine="${key}:${v}"${String(f[key]) === String(v) ? ' class="active"' : ''}>${l}</button>`).join('');
  box.innerHTML = `<span class="kb-fine-group"><small>价值</small>${seg('min', FINE_MIN)}</span>` +
    `<span class="kb-fine-group"><small>空间</small>${seg('space', FINE_SPACE)}</span>` +
    `<span class="kb-fine-group"><button type="button" data-fine="solo"${f.solo ? ' class="active"' : ''} title="只看一个人完成的击杀">单刷</button>` +
    `<button type="button" data-fine="npc"${f.npc ? ' class="active"' : ''} title="去掉被 NPC 打死的记录">排除 NPC 击杀</button>` +
    `<button type="button" data-fine="gank"${f.gank ? ' class="active"' : ''} title="高安里被自杀式攻击打掉的船（攻击者随后被统合部击毁），同时显示强爆最多的高安星系">疑似强爆</button></span>`;
}
function setFine(spec) {
  const [key, v] = spec.split(':');
  if (key === 'solo' || key === 'npc' || key === 'gank') S.fine[key] = !S.fine[key];
  else S.fine[key] = key === 'min' ? Number(v) : v;
  renderFine();
  loadFeed(true);
  loadGank();
}

// ---------- 高安强爆 ----------
// 判定：受害者被玩家击毁，且有攻击者在同一星系、前后 10 分钟内被 NPC（统合部）击毁——高安里只有非法攻击才会这样。
// 按高安星系筛选时显示该星系的强爆风险（各时段出现概率、主要团伙、常被打的船）；勾「疑似强爆」且没选星系时显示强爆最多的高安星系
function gankSystem() {
  const locs = S.filters.locs;
  const loc = locs.length === 1 ? locs[0] : null;
  if (loc?.kind !== 'system') return null;
  const sys = kb.systemLabel(Number(loc.id));
  return sys.sec != null && sys.sec >= 0.5 ? { id: Number(loc.id), ...sys } : null;
}
const gankHelpers = () => ({ esc: app.esc, isk: app.formatISK, num: app.formatNumber, typeName, typeIcon: (t) => IMG(`types/${t}/icon`, 32),
  avatar, entity: (kind, id) => entityLink(kind, id), ago: timeAgo });
const daysSeg = () => `<div class="segmented kb-gank-days" role="group" aria-label="统计天数">${[7, 30, 90].map((d) =>
  `<button type="button" data-gank-days="${d}"${S.gank.days === d ? ' class="active"' : ''}>${d} 天</button>`).join('')}</div>`;

async function loadGank(retry = 0) {
  const box = $('kbGank');
  if (!box) return;
  const sys = gankSystem();
  if (!sys && !S.fine.gank) { box.hidden = true; box.innerHTML = ''; return; }
  const seq = ++S.gank.seq;
  box.hidden = false;
  if (!retry) box.innerHTML = '<div class="kb-gank"><p class="text-muted">正在统计高安强爆…</p></div>';
  try {
    const d = await request('gank?' + new URLSearchParams(sys ? { system: sys.id, days: S.gank.days } : { days: S.gank.days }));
    if (seq !== S.gank.seq || !$('kbGank')) return;
    if (d.computing) {
      box.innerHTML = '<div class="kb-gank"><p class="text-muted">正在统计强爆最多的高安星系，第一次要一两分钟…</p></div>';
      if (retry < 40) setTimeout(() => { if (seq === S.gank.seq) loadGank(retry + 1); }, 4000);
      return;
    }
    absorbNames(d.names);
    if (sys) await loadTypes((d.ships || []).map((x) => x[0]));
    if (seq !== S.gank.seq) return;
    box.innerHTML = sys ? gankSystemHtml(sys, d, gankHelpers(), { head: daysSeg(),
      foot: `<p class="kb-gank-note text-muted"><span>${GANK_NOTE}</span> <span>下方列表勾「疑似强爆」可只看这些击杀。</span></p>` }) : gankHotHtml(d);
  } catch (error) {
    if (seq === S.gank.seq) box.innerHTML = `<div class="kb-gank"><p class="text-muted">高安强爆统计读取失败：${app.esc(error.message)}</p></div>`;
  }
}

function gankHotHtml(d) {
  const span = d.span || d.days;
  const list = (d.systems || []).slice(0, 12);
  const rows = list.map((x, i) => {
    const sys = kb.systemLabel(x.id);
    return `<div class="kb-gank-hot">
      <span class="kb-gank-rank">${i + 1}</span>
      <span class="kb-gank-sys"><a class="kb-link" data-location="system:${x.id}" title="查看这个星系的强爆风险">${app.esc(sys.name)}</a> <b style="color:${sys.color}">${sys.secText}</b>${sys.region ? `<small>${app.esc(sys.region)}</small>` : ''}</span>
      <span><b>${app.formatNumber(x.count)}</b> 次</span>
      <span title="出现强爆的天数">${x.days_hit} / ${span} 天</span>
      <span>${app.formatISK(x.value)} ISK</span>
      <small class="text-muted">${timeAgo(x.last * 1000)}</small>
    </div>`;
  }).join('');
  return `<div class="kb-gank">
    <div class="kb-gank-head"><h4>高安强爆热点</h4><small class="text-muted">最近 ${span} 天共 ${app.formatNumber(d.total || 0)} 次疑似强爆 · 点星系名看各时段概率和主要团伙</small><span class="toolbar-spacer"></span>${daysSeg()}</div>
    ${rows || '<p class="text-muted">没有发现疑似强爆记录</p>'}
    <p class="kb-gank-note text-muted">${GANK_NOTE}</p>
  </div>`;
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
    S.feedNotice = data.notice;
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

// ---------- 有新击杀就刷新：首页打开、页面可见时每 8 秒问一次实时接口（/live），有新击杀才按当前筛选重取第一页，把新的插到最前面 ----------
const LIVE_MS = 8000;
const live = { cursor: -1, timer: 0, busy: false, sumAt: 0 };
function startLive() {
  if (live.timer) return;
  live.timer = setInterval(pollLive, LIVE_MS);
}
async function pollLive() {
  if (live.busy || document.hidden || !$('kbFeed') || location.hash !== '#kb' || S.feedBusy) return;
  live.busy = true;
  try {
    const d = await request(`live?after=${live.cursor}${live.cursor < 0 ? '&initial=0' : ''}`);
    const first = live.cursor < 0;
    live.cursor = d.cursor;
    if (first || !d.kills?.length) return;
    await freshFeed();
    // 顶部统计不用每条都重算：最多一分钟一次
    if (Date.now() - live.sumAt > 60e3) { live.sumAt = Date.now(); loadSummary(); }
  } catch { /* 下次再试 */ } finally { live.busy = false; }
}
async function freshFeed() {
  const seq = S.feedSeq;
  const q = feedQuery();
  q.set('limit', 30);
  const data = await request('feed?' + q);
  if (seq !== S.feedSeq || !$('kbFeed') || S.feedBusy) return;
  const top = S.feed[0];
  const at = (k) => Date.parse(k.time);
  const have = new Set(S.feed.map((k) => k.id));
  const newer = top ? data.kills.filter((k) => !have.has(k.id) && (at(k) > at(top) || (at(k) === at(top) && k.id > top.id))) : data.kills;
  if (!newer.length) return;
  absorbNames(data.names);
  await loadTypes(typesOf(newer));
  if (seq !== S.feedSeq || !$('kbFeed')) return;
  S.feed = newer.concat(S.feed);
  if (!top) S.cursor = data.cursor;
  $('kbFeed').innerHTML = feedTable(S.feed, { notice: S.feedNotice });
  $('kbMore').hidden = !S.cursor;
}

function renderFilters() {
  const chips = [];
  const f = S.filters;
  const x = (key, id) => `<button data-clear-filter="${key}:${id}" aria-label="移除">×</button>`;
  for (const s of f.ships) chips.push(`<span class="kb-chip"><img src="${IMG(`types/${s.id}/icon`, 32)}" alt="" width="16" height="16">${app.esc(s.name)}${x('ships', s.id)}</span>`);
  for (const l of f.locs) chips.push(`<span class="kb-chip">${{ region: '星域', constellation: '星座' }[l.kind] || '星系'} · ${app.esc(l.name)}${x('locs', l.id)}</span>`);
  for (const e of f.ents) chips.push(`<span class="kb-chip"><img src="${avatar(e.kind, e.id, 32)}" alt="" width="16" height="16">${app.esc(e.name)}${x('ents', e.id)}</span>`);
  if (chips.length > 1) chips.push('<button class="kb-chip kb-chip-clear" data-clear-filter="all">清空</button>');
  $('kbFilters').innerHTML = chips.join('');
}

// 筛选：add 加进同类（搜索框里逐个选，可多选）；set 只留这一个（点列表里的星系名等）；remove 去掉一个；all 全部清空
function setFilter(key, op, item) {
  const f = S.filters;
  if (key === 'all') { f.ships = []; f.locs = []; f.ents = []; }
  else if (op === 'remove') f[key] = f[key].filter((x) => x.id !== item);
  else if (op === 'set') f[key] = [item];
  else if (!f[key].some((x) => x.id === item.id)) f[key] = [...f[key], item];
  if (location.hash !== '#kb') { history.pushState(null, '', '#kb'); renderHome(); return; }
  renderFilters();
  loadFeed(true);
  loadGank();
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
  const rule = `${battles.BATTLE_WINDOW} 分钟内击毁：${tiers.map((t) => `<span class="kb-tier-chip tier-${t.key}"><i></i>${t.name.replace('会战', '')} ${t.min}+</span>`).join('')}`;
  const head = `<div class="kb-battles-head">
      <h3 class="kb-section-title"><svg class="battle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></svg>${list.length ? `疑似会战 <b>${list.length}</b>` : '暂无疑似会战'}</h3>
      <span class="text-muted kb-battle-rule" title="不含太空舱、NPC 击杀与 10M ISK 以下">${rule}</span>
      <a class="btn btn-ghost kb-bh-entry" href="#kb/battles" data-kb-bh title="最近 30 天全部疑似会战、双方战损比，可筛选">近 30 天会战 ›</a>
      <span class="kb-battle-notify"><label class="jump-check"><span>提醒规模</span><select class="cr-input kb-battle-min" data-battle-set="min" aria-label="提醒规模">${tiers.map((t) => `<option value="${t.key}"${set.min === t.key ? ' selected' : ''}>${t.key === 'small' ? '全部' : t.name.replace('会战', '') + '以上'}</option>`).join('')}</select></label>
        <label class="jump-check"><input type="checkbox" data-battle-set="on"${set.on ? ' checked' : ''}><span>弹出提醒</span></label>
        <button type="button" class="link-btn" data-battle-push title="新会战推送到企业微信、邮箱、Server酱等，在「预警 → 消息推送」里勾选「会战」">消息推送</button></span>
    </div>`;
  const cards = list.map((b) => {
    const sys = kb.systemLabel(b.system_id);
    const mins = Math.max(1, Math.round((new Date(b.end) - new Date(b.start)) / 60e3));
    const tier = battles.battleTier(b.kills);
    const sides = b.sides.map((x) => `<span class="kb-battle-side">${entityLink(x.kind, x.id, names[x.id] || partyName(x.id))}<small>击杀 ${x.kills} · 损失 ${x.losses}</small></span>`).join('');
    return `<article class="kb-battle tier-${tier.key}" ${brCardAttrs(b)}>
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
        </div>
      </article>`;
  }).join('');
  box.innerHTML = head + (cards ? `<div class="kb-battle-list">${cards}</div>` : '');
  box.classList.toggle('is-empty', !list.length);
}

// 会战卡片整块可点：点空白处打开战场统计（卡片里的链接、按钮照常）
const brCardAttrs = (x) => `data-br-battle="${x.system_id}" data-start="${x.start}" data-end="${x.end}" data-br-card title="打开战场统计"`;

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
        <span class="kb-board-name" translate="no">${app.esc(r.name || partyName(r.id))}</span>
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
    ${backLink()}
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
  const kind = KIND_ZH[r.by];
  const first = r.data.first || (rows[0] && { ...rows[0] });
  const sideTotal = r.data.side_total;
  const cards = `<div class="kb-summary-cards kb-rank-cards">
      <div class="valuation-card ${r.side === 'kills' ? 'is-buy' : 'is-sell'}"><span class="valuation-label">上榜${kind}</span>
        <strong class="valuation-value">${fmtN(paged ? r.data.entities : rows.length)}<span class="unit">个</span></strong>
        <span class="valuation-detail">${sideTotal ? `合计 ${fmtIsk(sideTotal.value)} ISK` : ''}</span></div>
      ${first ? `<div class="valuation-card"><span class="valuation-label">第 1 名</span>
        <strong class="valuation-value kb-rank-first"><a class="kb-link" href="#kb/${r.by}/${first.id}" data-entity="${r.by}:${first.id}" translate="no">${app.esc(first.name || partyName(first.id))}</a></strong>
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
        <span>${r.by === 'character' ? stOf({ character_id: row.id, corporation_id: row.corporation_id, alliance_id: row.alliance_id }) : stKind(r.by, row.id)}<a class="kb-link" href="#kb/${r.by}/${row.id}" data-entity="${r.by}:${row.id}" translate="no">${app.esc(row.name || partyName(row.id))}</a>
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
    : '服务版本较旧，仅显示前几名';
  const sizeSel = paged ? `<label class="kb-pager-size">每页 <select data-rank-size aria-label="每页条数">${RANK_SIZES.map((n) => `<option value="${n}"${n === r.size ? ' selected' : ''}>${n}</option>`).join('')}</select> 条</label>` : '';
  const exportBtn = rows.length ? exportBtnHtml('data-kb-rank-export') : '';
  const bar = `<div class="kb-rank-bar"><span class="text-muted">${info}</span><span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap">${sizeSel}${exportBtn}</span></div>`;
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

// 导出 CSV：服务端分页（每次最多 100 条），按当前筛选从第 1 名起连续读取，最多导出前 EXPORT_MAX 名
const EXPORT_MAX = 1000;
let exporting = false;
async function exportRank() {
  const r = S.rank;
  if (!r?.data?.rows?.length || exporting) return;
  exporting = true;
  const rows = [];
  try {
    app.showToast(`正在读取前 ${EXPORT_MAX} 名…`, 'info', 1500);
    const q = r.filter ? '&q=' + encodeURIComponent(r.filter) : '';
    while (rows.length < EXPORT_MAX) {
      const data = await api(`leaderboard?days=${r.days}&side=${r.side}&by=${r.by}&metric=${r.metric}&offset=${rows.length}&limit=100${q}&detail=1`);
      if (rows.length && data.rows?.[0]?.id === rows[0].id) break;   // 旧版服务不支持 offset，会重复返回第一页
      absorbNames(data.names);
      for (const row of data.rows || []) if (row.name) S.names.set(row.id, row.name);
      await loadTypes((data.rows || []).flatMap((row) => (row.ships || []).map((x) => x.ship_type_id)));
      rows.push(...(data.rows || []));
      if (!data.rows || data.rows.length < 100) break;
    }
  } catch (error) {
    app.showToast('导出失败：' + error.message, 'error', 3000);
    exporting = false;
    return;
  }
  exporting = false;
  if (!rows.length) return;
  const total = r.data.total;
  const detail = rows[0].kills != null;
  const cols = [
    ['#', (row) => row.rank ?? rows.indexOf(row) + 1],
    [KIND_ZH[r.by], (row) => row.name || partyName(row.id)],
    ['ID', (row) => row.id]
  ];
  if (r.by === 'character') cols.push(['所属军团', (row) => partyName(row.corporation_id)]);
  if (r.by !== 'alliance') cols.push(['所属联盟', (row) => partyName(row.alliance_id)]);
  if (detail) {
    cols.push(
      ['击毁价值', (row) => row.destroyed], ['击杀次数', (row) => row.kills],
      ['损失价值', (row) => row.lost], ['损失次数', (row) => row.losses],
      ['效率 %', (row) => { const e = rankEff(row); return e == null ? null : e * 100; }],
      ['占全服 %', (row) => (total?.value ? row.value / total.value * 100 : null)],
      [r.side === 'kills' ? '常驾舰船' : '常损舰船', (row) => (row.ships || []).map((x) => `${typeName(x.ship_type_id)} ×${x.count}`).join(' / ')]
    );
  } else cols.push(['价值', (row) => row.value], ['次数', (row) => row.count]);
  const n = exportCsv('击杀排行榜', cols, rows);
  app.showToast(`已导出 ${n} 行`, 'success', 1800);
}

// ---------- 近 30 天疑似会战：#kb/battles ----------
// 数据：/api/kb/battles/history?days=30（服务端每 10 分钟重算）。同一星系相邻击杀间隔 ≤ 20 分钟连成一场，场内任意 60 分钟击毁 ≥ 20 艘才算；
// 双方按「谁打谁」由服务端分队，战损比 = 击毁 ÷（击毁 + 损失），按 ISK 算。筛选、排序、分页都在浏览器里做。
const BH_PAGE = 30;
const BH_DAYS = [[1, '24 小时'], [7, '7 天'], [30, '30 天']];
const BH_SIZES = [[0, '全部'], [20, '小型 20+'], [50, '中型 50+'], [100, '大型 100+']];
const BH_SECS = [['all', '全部'], ['high', '高安'], ['low', '低安'], ['null', '00'], ['wh', '虫洞']];
const BH_SORTS = [['time', '最近'], ['kills', '击毁数'], ['value', '总价值'], ['pilots', '参与人数'], ['ratio', '一边倒']];

function secKind(id) {
  if (id >= 31000000 && id < 32000000) return 'wh';
  const s = kb.systemLabel(id);
  return s.sec == null ? 'wh' : s.sec >= 0.5 ? 'high' : s.sec > 0 ? 'low' : 'null';
}

function renderBattleHistory() {
  S.entity = null;
  S.rank = null;
  S.bh = { days: 30, size: 0, sec: 'all', region: '', q: '', sort: 'time', shown: BH_PAGE, ...(S.bh || {}), data: S.bh?.data || null };
  $('kbMain').innerHTML = `
    ${backLink()}
    <section class="kb-rank-page kb-bh-page">
      <div class="kb-rank-head"><h2>近 30 天疑似会战</h2><span class="text-muted" id="kbBhSub"></span></div>
      <div class="kb-rank-controls" id="kbBhControls"></div>
      <div id="kbBhBody">${skCards(3)}${skRows(8)}</div>
    </section>`;
  if (S.bh.data) { drawBhControls(); drawBh(); }
  loadBattleHistory();
}

async function loadBattleHistory() {
  try {
    const data = await api('battles/history?days=30');
    if (!location.hash.startsWith('#kb/battles')) return;
    absorbNames(data.names);
    S.bh.data = data;
    drawBhControls();
    drawBh();
  } catch (error) {
    if ($('kbBhBody') && !S.bh.data) $('kbBhBody').innerHTML = '<p class="text-muted kb-empty">读取失败：' + app.esc(error.message) + '</p>';
  }
}

function drawBhControls() {
  const b = S.bh;
  const seg = (key, options) => `<div class="segmented" role="group">` +
    options.map(([v, label]) => `<button type="button" data-bh="${key}:${v}" class="${String(b[key]) === String(v) ? 'active' : ''}">${label}</button>`).join('') + '</div>';
  const regions = [...new Set((b.data?.battles || []).map((x) => kb.systemLabel(x.system_id).region).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'zh'));
  $('kbBhControls').innerHTML = seg('days', BH_DAYS) + seg('size', BH_SIZES) + seg('sec', BH_SECS) +
    `<select class="plain-select kb-bh-select" data-bh-region aria-label="星域"><option value="">全部星域</option>${regions.map((r) => `<option${r === b.region ? ' selected' : ''}>${app.esc(r)}</option>`).join('')}</select>
    <select class="plain-select kb-bh-select" data-bh-sort aria-label="排序">${BH_SORTS.map(([v, l]) => `<option value="${v}"${v === b.sort ? ' selected' : ''}>按${l}</option>`).join('')}</select>
    <label class="search-box kb-rank-filter"><svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input type="search" id="kbBhFilter" placeholder="联盟 / 军团 / 星系名" autocomplete="off" aria-label="按名称筛选" value="${app.esc(b.q)}"></label>`;
  $('kbBhFilter').addEventListener('input', app.debounce((e) => { S.bh.q = e.target.value.trim(); S.bh.shown = BH_PAGE; drawBh(); }, 250));
}

// 一边倒程度：双方战损比差得越多越一边倒
const bhRatio = (t0, t1) => {
  const a = t0.destroyed + t0.lost, b = t1.destroyed + t1.lost;
  return { a: a ? t0.destroyed / a : null, b: b ? t1.destroyed / b : null };
};

function filteredBattles() {
  const b = S.bh;
  const since = Date.now() - b.days * 86400e3;
  const q = b.q.toLowerCase();
  const list = (b.data?.battles || []).filter((x) => {
    if (new Date(x.end).getTime() < since) return false;
    if (b.size && x.kills < b.size) return false;
    if (b.sec !== 'all' && secKind(x.system_id) !== b.sec) return false;
    if (b.region && kb.systemLabel(x.system_id).region !== b.region) return false;
    if (q) {
      const names = [kb.systemLabel(x.system_id).name, ...x.teams.flatMap((t) => t.entities.map((e) => partyName(e.id)))];
      if (!names.some((n) => String(n).toLowerCase().includes(q))) return false;
    }
    return true;
  });
  const key = {
    time: (x) => new Date(x.end).getTime(), kills: (x) => x.kills, value: (x) => x.value, pilots: (x) => x.pilots,
    ratio: (x) => { const r = bhRatio(x.teams[0], x.teams[1]); return r.a == null ? -1 : Math.abs(r.a - 0.5); }
  }[b.sort];
  return list.sort((x, y) => key(y) - key(x));
}

function drawBh() {
  const box = $('kbBhBody');
  const b = S.bh;
  if (!box || !b.data) return;
  const list = filteredBattles();
  const fmtIsk = app.formatISK, fmtN = app.formatNumber;
  const total = list.reduce((s, x) => s + x.value, 0), kills = list.reduce((s, x) => s + x.kills, 0);
  const large = list.filter((x) => x.kills >= 100).length;
  $('kbBhSub').textContent = `共 ${fmtN(b.data.battles.length)} 场 · 统计于 ${new Date(b.data.updated).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
  const cards = `<div class="kb-summary-cards kb-rank-cards">
      <div class="valuation-card"><span class="valuation-label">符合条件的会战</span><strong class="valuation-value">${fmtN(list.length)}<span class="unit">场</span></strong><span class="valuation-detail">其中大型（100 艘以上）${large} 场</span></div>
      <div class="valuation-card is-sell"><span class="valuation-label">击毁舰船</span><strong class="valuation-value">${fmtN(kills)}<span class="unit">艘</span></strong><span class="valuation-detail">不含太空舱与 10M 以下</span></div>
      <div class="valuation-card"><span class="valuation-label">总价值</span><strong class="valuation-value">${fmtIsk(total)}<span class="unit">ISK</span></strong></div>
    </div>`;
  const page = list.slice(0, b.shown);
  loadTypes(page.map((x) => x.top?.ship_type_id).filter(Boolean)).then(() => {
    page.forEach((x) => { const el = box.querySelector(`[data-bh-top="${x.top?.id}"]`); if (el) el.textContent = `最贵损失 ${typeName(x.top.ship_type_id)} · ${fmtIsk(x.top.value)}`; });
  });
  const rows = page.map((x) => {
    const sys = kb.systemLabel(x.system_id);
    const tier = battles ? battles.battleTier(x.kills) : { key: 'small', name: '会战' };
    const mins = Math.max(1, Math.round((new Date(x.end) - new Date(x.start)) / 60e3));
    const r = bhRatio(x.teams[0], x.teams[1]);
    const multi = x.teams.length > 2;
    // 三方混战：每方卡片里各自带战损比
    const own = (t) => { const n = t.destroyed + t.lost; return multi && n ? `<span>战损比 ${(t.destroyed / n * 100).toFixed(0)}%</span>` : ''; };
    const team = (t, cls) => `<div class="kb-bh-team ${cls}">
        <div class="kb-bh-team-head"><b>${fmtIsk(t.lost)}</b><small>损失 ISK</small></div>
        <div class="kb-bh-ents">${t.entities.length ? t.entities.map((e) => `<span class="kb-bh-ent"><img src="${avatar(e.kind, e.id, 32)}" alt="" width="18" height="18" loading="lazy">${entityLink(e.kind, e.id, partyName(e.id))}</span>`).join('') : '<span class="text-muted">—</span>'}
          ${t.n_entities > t.entities.length ? `<small class="text-muted">等 ${t.n_entities} 个势力</small>` : ''}</div>
        <div class="kb-bh-nums"><span>约 ${fmtN(t.pilots)} 人</span><span class="up">击毁 ${fmtN(t.kills)} 艘 · ${fmtIsk(t.destroyed)}</span><span class="down">损失 ${fmtN(t.losses)} 艘</span>${own(t)}</div>
      </div>`;
    const sum = x.teams[0].lost + x.teams[1].lost;
    const dsum = x.teams.reduce((n, t) => n + t.destroyed, 0);
    const bar = multi ? (dsum ? `<div class="kb-bh-bar is-multi" title="各方击毁 ISK 占比">${x.teams.map((t, i) => t.destroyed ? `<i class="${'abc'[i]}" style="width:${(t.destroyed / dsum * 100).toFixed(1)}%"></i>` : '').join('')}</div>` : '') : sum ? `<div class="kb-bh-bar" title="双方损失 ISK 对比：蓝色越长左方打得越好（左方损失 ${fmtIsk(x.teams[0].lost)}，右方损失 ${fmtIsk(x.teams[1].lost)}）"><i class="a" style="width:${((x.teams[1].lost / sum) * 100).toFixed(1)}%"></i><i class="b" style="width:${((x.teams[0].lost / sum) * 100).toFixed(1)}%"></i></div>` : '';
    return `<article class="kb-bh tier-${tier.key}" ${brCardAttrs(x)}>
      <div class="kb-bh-head">
        <span class="kb-bh-tier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></svg>${tier.name}</span>
        <a class="kb-link kb-bh-sys" data-location="system:${x.system_id}">${app.esc(sys.name)}</a> <b style="color:${sys.color}">${sys.secText}</b>
        <span class="text-muted">${app.esc(sys.region || '')} · ${new Date(x.start).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 起，持续 ${mins >= 120 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟'}</span>
        <span class="kb-bh-stats"><b>${fmtN(x.kills)}</b> 艘 · 约 <b>${fmtN(x.pilots)}</b> 人 · <b>${fmtIsk(x.value)}</b> ISK</span>
      </div>
      ${multi ? `<div class="kb-bh-vs is-multi">${x.teams.map((t, i) => team(t, 'side-' + 'abc'[i])).join('')}</div>`
        : `<div class="kb-bh-vs">${team(x.teams[0], 'left')}<span class="kb-bh-x">VS</span>${team(x.teams[1], 'right')}</div>`}
      ${bar}
      ${multi ? '' : (r.a != null || r.b != null ? `<div class="kb-bh-ratio"><span class="left"><small>战损比</small><b>${r.a == null ? '—' : (r.a * 100).toFixed(0) + '%'}</b></span><span class="right"><b>${r.b == null ? '—' : (r.b * 100).toFixed(0) + '%'}</b><small>战损比</small></span></div>` : '')}
      <div class="kb-battle-actions">
        ${x.top ? `<button class="link-btn" data-kill="${x.top.id}" data-bh-top="${x.top.id}">最贵损失 ${app.esc(typeName(x.top.ship_type_id))} · ${fmtIsk(x.top.value)}</button>` : ''}
        ${x.third.losses ? `<span class="text-muted kb-bh-third">第三方损失 ${x.third.losses} 艘</span>` : ''}
        <button class="btn btn-ghost" data-battle-map="${x.system_id}">在星图查看</button>
        <button class="btn btn-ghost" data-br-battle="${x.system_id}" data-start="${x.start}" data-end="${x.end}">战场统计</button>
      </div>
    </article>`;
  }).join('');
  box.innerHTML = cards + (rows ? `<div class="kb-bh-list">${rows}</div>` : '<p class="text-muted kb-empty">没有符合条件的会战</p>') +
    (list.length > b.shown ? `<div class="au-more"><button class="btn btn-ghost" data-bh-more>再显示 ${Math.min(BH_PAGE, list.length - b.shown)} 场（还有 ${list.length - b.shown} 场）</button></div>` : '') +
    `<p class="text-muted valuation-note" title="口径：同一星系相邻击杀间隔不超过 ${b.data.gap_minutes} 分钟算同一场，场内任意 60 分钟击毁 ≥ ${b.data.min} 艘（不含太空舱、NPC 击杀与 10M ISK 以下）。 双方按「谁打谁」自动分队（一起出手的算友方），对两方都下过手的势力单独算一方（三方混战），与各方都没有交火的算第三方；战损比 = 击毁 ÷（击毁 + 损失），按 ISK 算。价值为估算值">价值为估算值</p>`;
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
  return backLink() + skEntityHead() +
    (kind === 'character' ? skTitle(14) + skCards(5) : '') + skTitle(18) + skCards(6) +
    skTitle(12) + skToolbar(3) + skRows(8);
}

async function renderEntity(kind, id) {
  const main = $('kbMain');
  S.entity = { kind, id, side: 'all', feed: [], cursor: null, sort: { key: 'destroyed', dir: 'desc' } };
  main.innerHTML = entitySkeleton(kind);
  let d;
  try {
    d = await entityData(kind, id);
  } catch (error) {
    if (S.entity?.id === id) main.innerHTML = '<p class="text-muted kb-empty">统计读取失败：' + app.esc(error.message) + '</p>';
    return;
  }
  if (S.entity?.id !== id) return;
  const { stats, lifetime } = d;
  Object.assign(S.entity, { stats, info: d.info, lifetime });
  trailNames.set(location.hash, d.info?.name || stats.name || partyName(id));
  const P = entityParts(kind, id, d);
  main.innerHTML = `
    ${backLink()}
    ${P.head.replace('<div class="kb-ext-links">', `<div class="kb-ext-links"><button class="btn btn-ghost kb-share-btn" data-entity-tofeed title="直接跳到下面的击杀记录">${DOWN_SVG}<span>击杀记录</span></button><button class="btn btn-ghost kb-share-btn" data-entity-share title="生成${KIND_ZH[kind]}统计图片，可下载或复制后分享">${SHARE_SVG}<span>分享图片</span></button>`)}
    ${P.lifetime}${monthlyHtml(lifetime)}${P.recent}
    ${stats.members ? `<h4 class="info-section-title section-gap">${kind === 'alliance' ? '成员军团' : '成员'}<small>（最近 30 天）</small></h4><div id="kbMembers"></div>` : ''}
    ${P.activity}${P.corpHistory}
    ${kind === 'character' ? `<h4 class="info-section-title section-gap" id="kbPbTitle">参加过的会战<small>（最近 180 天）</small></h4><div id="kbPilotBattles">${skRows(3)}</div>` : ''}
    ${/kb-mini-panel/.test(P.ships) ? `<h4 class="info-section-title section-gap">舰船<small>（最近 30 天）</small></h4>${P.ships}` : ''}
    <div class="kb-feed-head section-gap" id="kbEntityFeedHead">
      <h4 class="info-section-title">击杀记录</h4>
      <div class="segmented" role="group">
        ${[['all', '全部'], ['kills', '击杀'], ['losses', '损失']].map(([v, l]) => `<button data-entity-side="${v}" class="${v === 'all' ? 'active' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div id="kbEntityFeed">${skRows(8)}</div>
    <button class="btn kb-more" id="kbEntityMore" hidden>加载更多</button>`;
  mountMonthly(main, lifetime);
  foldSections(main);
  if (stats.members) renderMembers();
  // 广场里有这个军团的招新广告时，头部加一个入口
  if (kind === 'corporation') app.plazaRecruit?.(id).then((p) => {
    const links = S.entity?.id === id && main.querySelector('.kb-ext-links');
    if (p && links) links.insertAdjacentHTML('afterbegin', `<a class="btn btn-primary kb-recruit" href="#plaza/p/${p.id}">招新中</a>`);
  }).catch(() => {});
  $('kbEntityMore').addEventListener('click', () => loadEntityFeed(false));
  loadEntityFeed(true);
  if (kind === 'character') loadPilotBattles(id);
}

// 人物 / 军团 / 联盟页的每一节（生涯统计、月度统计、成员、历史军团、会战、舰船…）都能折叠，默认展开；
// 收起的记在本机（按小节名），下次打开任何人物 / 军团 / 联盟页还是收起的。击杀记录不折叠。
// 标题 h4 原样放进 summary（会战标题之后还会按 id 更新），标题后面到下一个标题之间的内容放进 details。
const FOLD_KEY = 'eve-kb-fold';
const foldKey = (h) => (h.firstChild?.textContent || h.textContent).trim();
function foldedSet() { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } }
function foldSections(main) {
  const closed = foldedSet();
  for (const h of [...main.querySelectorAll(':scope > h4.info-section-title')]) {
    const key = foldKey(h);
    const det = document.createElement('details');
    det.className = 'kb-fold' + (h.classList.contains('section-gap') ? ' section-gap' : '');
    det.open = !closed.has(key);
    det.dataset.fold = key;
    const sum = document.createElement('summary');
    h.before(det);
    h.classList.remove('section-gap');
    sum.append(h);
    det.append(sum);
    while (det.nextSibling && !(det.nextSibling.nodeType === 1 && (det.nextSibling.matches('h4.info-section-title, details.kb-fold, .kb-feed-head')))) det.append(det.nextSibling);
    det.addEventListener('toggle', () => {
      const set = foldedSet();
      if (det.open) set.delete(key); else set.add(key);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch { /* 隐私模式 */ }
      if (det.open && det.querySelector('canvas, .kb-chart')) mountMonthly(main, S.entity?.lifetime);   // 收起时画不了图，展开后补画
    });
  }
}

// ---------- 人物参加过的会战（/battles/pilot，最近 180 天，受本地保留期限制） ----------
const PB_PAGE = 8;
async function loadPilotBattles(id) {
  let d;
  try { d = await api(`battles/pilot?character=${id}&days=180`); } catch (error) {
    const box = S.entity?.id === id && $('kbPilotBattles');
    if (box) box.innerHTML = '<p class="text-muted">会战记录读取失败：' + app.esc(error.message) + '</p>';
    return;
  }
  if (S.entity?.id !== id || !$('kbPilotBattles')) return;
  absorbNames(d.names);
  await loadTypes(d.battles.flatMap((b) => [...b.me.ships, ...b.me.losses.map((l) => l.ship_type_id)]));
  S.entity.pb = { data: d, shown: PB_PAGE };
  drawPilotBattles();
}
function drawPilotBattles() {
  const box = $('kbPilotBattles'), pb = S.entity?.pb;
  if (!box || !pb) return;
  const { data: d, shown } = pb;
  const title = $('kbPbTitle');
  if (title) title.innerHTML = `参加过的会战<small>（最近 ${d.days} 天${d.battles.length ? ' · ' + d.battles.length + ' 场' : ''}）</small>`;
  if (!d.battles.length) { box.innerHTML = `<p class="text-muted">最近 ${d.days} 天没有参加过会战（同一星系 60 分钟内击毁 ≥ ${d.min} 艘）。</p>`; return; }
  const fmtIsk = app.formatISK, fmtN = app.formatNumber;
  const ship = (t) => `<span class="kb-pb-ship"><img src="${IMG(`types/${t}/icon`, 32)}" alt="" width="18" height="18" loading="lazy">${app.esc(typeName(t))}</span>`;
  const rows = d.battles.slice(0, shown).map((x) => {
    const sys = kb.systemLabel(x.system_id);
    const tier = battles ? battles.battleTier(x.kills) : { key: 'small', name: '会战' };
    const mins = Math.max(1, Math.round((new Date(x.end) - new Date(x.start)) / 60e3));
    const me = x.me;
    const losses = me.losses.filter((l) => l.ship_type_id !== 670 && l.ship_type_id !== 33328);
    return `<article class="kb-bh kb-pb tier-${tier.key}" ${brCardAttrs(x)}>
      <div class="kb-bh-head">
        <span class="kb-bh-tier">${tier.name}</span>
        <a class="kb-link kb-bh-sys" data-location="system:${x.system_id}">${app.esc(sys.name)}</a> <b style="color:${sys.color}">${sys.secText}</b>
        <span class="text-muted">${app.esc(sys.region || '')} · ${new Date(x.start).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 起，持续 ${mins >= 120 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟'}</span>
        <span class="kb-bh-stats"><b>${fmtN(x.kills)}</b> 艘 · 约 <b>${fmtN(x.pilots)}</b> 人 · <b>${fmtIsk(x.value)}</b> ISK</span>
      </div>
      <div class="kb-pb-me">
        ${me.entity ? `<span class="kb-bh-ent"><img src="${avatar(me.entity.kind, me.entity.id, 32)}" alt="" width="18" height="18" loading="lazy">${entityLink(me.entity.kind, me.entity.id, partyName(me.entity.id))}</span>` : ''}
        ${me.ships.length ? `<span class="kb-pb-lbl">驾驶</span>${me.ships.map(ship).join('')}` : ''}
        <span class="kb-pb-lbl">参与击杀</span><b class="up">${fmtN(me.kills)}</b>
        <span class="kb-pb-lbl">损失</span>${losses.length ? losses.map((l) => `<button class="link-btn kb-pb-loss" data-kill="${l.id}" title="${fmtIsk(l.value)} ISK">${ship(l.ship_type_id)}</button>`).join('') + `<b class="down">${fmtIsk(me.lost)}</b>` : '<span class="text-muted">无</span>'}
        <span class="toolbar-spacer"></span>
        <button class="btn btn-ghost btn-sm" data-br-battle="${x.system_id}" data-start="${x.start}" data-end="${x.end}">战场统计</button>
      </div>
    </article>`;
  }).join('');
  box.innerHTML = `<div class="kb-bh-list">${rows}</div>` +
    (d.battles.length > shown ? `<div class="au-more"><button class="btn btn-ghost" data-pb-more>再显示 ${Math.min(PB_PAGE, d.battles.length - shown)} 场（还有 ${d.battles.length - shown} 场）</button></div>` : '');
}

// ---------- 分享图片 ----------
const DOWN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';
const KIND_EN = { character: 'PILOT', corporation: 'CORPORATION', alliance: 'ALLIANCE' };

function entityImageModel(e) {
  const { kind, id, stats, info, lifetime: z } = e;
  const num = app.formatNumber, isk = app.formatISK;
  const day = (d) => new Date(d).toLocaleDateString('zh-CN');
  const eff = stats.destroyed + stats.lost ? stats.destroyed / (stats.destroyed + stats.lost) * 100 : null;
  const subs = [], chips = [];
  if (kind === 'character') {
    if (info.corporation_id) subs.push({ text: partyName(info.corporation_id), icon: avatar('corporation', info.corporation_id, 64) });
    if (info.alliance_id) subs.push({ text: partyName(info.alliance_id), icon: avatar('alliance', info.alliance_id, 64) });
    if (info.birthday) chips.push('创建于 ' + day(info.birthday));
  } else {
    if (kind === 'corporation' && info.alliance_id) subs.push({ text: partyName(info.alliance_id), icon: avatar('alliance', info.alliance_id, 64) });
    if (info.ticker) chips.push('[' + info.ticker + ']');
    if (info.member_count) chips.push(num(info.member_count) + ' 名成员');
    if (info.date_founded) chips.push('成立于 ' + day(info.date_founded));
  }
  const kill = (k) => {
    const v = k.victim;
    return {
      icon: IMG(`types/${k.ship_type_id}/icon`, 64), ship: typeName(k.ship_type_id),
      who: [partyName(v.character_id || v.corporation_id), partyName(v.alliance_id || (v.character_id ? v.corporation_id : 0))].filter(Boolean).join(' · '),
      value: isk(k.value) + ' ISK', time: day(k.time)
    };
  };
  const ship = (s) => ({ icon: IMG(`types/${s.ship_type_id}/icon`, 64), name: typeName(s.ship_type_id), count: s.count });
  let life = null;
  if (z && z.shipsDestroyed !== undefined) {
    const le = (z.iskDestroyed || 0) + (z.iskLost || 0) ? z.iskDestroyed / (z.iskDestroyed + z.iskLost) * 100 : null;
    life = {
      kills: num(z.shipsDestroyed || 0), losses: num(z.shipsLost || 0), destroyed: isk(z.iskDestroyed || 0), lost: isk(z.iskLost || 0),
      solo: num(z.soloKills || 0), soloLosses: num(z.soloLosses || 0), eff: le == null ? '—' : le.toFixed(1) + '%',
      ratios: `危险度 ${z.dangerRatio ?? '—'}% · 团战 ${z.gangRatio ?? '—'}%`
    };
  }
  const memberKind = kind === 'alliance' ? 'corporation' : 'character';
  return {
    kind, kindLabel: KIND_ZH[kind], kindEn: KIND_EN[kind], round: kind === 'character',
    name: info.name || stats.name || partyName(id), avatar: avatar(kind, id, 256), subs, chips,
    days: Math.round(stats.days || 30), valueLabel: VALUE_LABEL,
    recent: {
      kills: num(stats.kills), losses: num(stats.losses), destroyed: isk(stats.destroyed), lost: isk(stats.lost), solo: num(stats.solo_kills), eff,
      finalBlows: stats.final_blows != null ? num(stats.final_blows) : null,
      finalShare: stats.final_blows != null && stats.kills ? `占参与击杀 ${(stats.final_blows / stats.kills * 100).toFixed(0)}%` : ''
    },
    lifetime: life,
    topKills: (stats.top_kills || []).map(kill), topLosses: (stats.top_losses || []).map(kill),
    shipsUsed: stats.ships_used.slice(0, 6).map(ship), shipsLost: stats.ships_lost.slice(0, 6).map(ship),
    regions: (stats.regions || []).slice(0, 6).map((r) => ({ name: partyName(r.region_id), count: r.count })),
    systems: (stats.systems || []).slice(0, 6).map((x) => { const l = kb.systemLabel(x.system_id); return { name: l.name, sec: l.secText, level: l.sec, region: l.region, count: x.count }; }),
    membersTitle: kind === 'alliance' ? '最活跃的成员军团' : '最活跃的成员',
    members: (stats.members || []).filter((s) => s.destroyed > 0).slice(0, 8).map((s) => ({
      icon: avatar(memberKind, s.id, 64), round: memberKind === 'character', name: s.name || partyName(s.id),
      detail: `参与击杀 ${num(s.kills)} · 损失 ${num(s.losses)}`, value: isk(s.destroyed)
    })),
    footer: VALUE_LABEL,
    generated: '生成于 ' + fullIn(Math.floor(Date.now() / 1000), 'cn') + ' UTC+8'
  };
}

let shareModules = null;
function shareEntity() {
  const e = S.entity;
  if (!e?.stats) return;
  if (!shareModules) shareModules = Promise.all([import('./kb-card-image.js?v=10'), import('./share-image.js?v=9')]);
  const model = entityImageModel(e);
  shareModules.then(([{ renderEntityImage }, { openShareModal, shareUrl }]) => openShareModal({
    title: `分享${KIND_ZH[e.kind]}图片`, app,
    fileName: `${KIND_ZH[e.kind]}-${model.name}.png`,
    render: (theme) => renderEntityImage({ ...model, url: shareUrl(`#kb/${e.kind}/${e.id}`) }, theme),
    link: () => location.href
  })).catch((error) => {
    shareModules = null;
    app.showToast('生成图片失败：' + error.message, 'error', 4000);
  });
}

// 实体页的数据：最近 30 天统计、公开资料、zKillboard 生涯统计（宁静服）、人物的军团履历；相关名称与舰船类型都读好
async function entityData(kind, id) {
  const [stats, info, lifetime, history] = await Promise.all([
    api(`entity/${kind}/${id}?days=30`),
    publicInfo(kind, id),
    IS_TQ ? kb.fetchZkill(`stats/${kind}ID/${id}/`).catch(() => null) : null,
    kind === 'character' ? app.fetchESI(`/characters/${id}/corporationhistory/`).catch(() => []) : []
  ]);
  if (stats.name) S.names.set(id, stats.name);
  if (info.name) S.names.set(id, info.name);
  absorbNames(stats.names);
  const related = [info.corporation_id, info.alliance_id, ...history.map((h) => h.corporation_id)].filter((x) => x && !S.names.has(x) && !app.officialName(x));
  if (related.length) { const named = await app.resolveNames(related); for (const [k, v] of named.names) S.names.set(k, v); }
  await loadTypes([...stats.ships_used, ...stats.ships_lost, ...(stats.top_kills || []), ...(stats.top_losses || [])].map((s) => s.ship_type_id));
  return { stats, info, lifetime, history };
}

// 悬浮窗（float-detail.html）里的人物详情：实体页去掉图表、成员与翻页，击杀记录只列最近 20 条
export async function charDetail(id) {
  await ensureReady();
  const [d, feed] = await Promise.all([entityData('character', id), api('feed?' + new URLSearchParams({ character: id, side: 'all', limit: 20 }))]);
  absorbNames(feed.names);
  await loadTypes(typesOf(feed.kills));
  const P = entityParts('character', id, d);
  return {
    title: d.info.name || d.stats.name || partyName(id),
    html: `<div class="kb-float">${P.head}${P.lifetime}${P.recent}${P.activity}${P.corpHistory}${P.ships}
      <h4 class="info-section-title section-gap">最近击杀记录</h4>${feedTable(feed.kills, { me: { key: 'character_id', id } })}</div>`
  };
}

function entityParts(kind, id, { stats, info, lifetime, history }) {
  const name = info.name || stats.name || partyName(id);
  const eff = stats.destroyed + stats.lost ? stats.destroyed / (stats.destroyed + stats.lost) * 100 : null;
  const sub = [];
  // 军团 / 联盟：图标 + 名字
  const org = (k, oid) => `<span class="kb-head-org"><img src="${avatar(k, oid, 32)}" alt="" width="20" height="20" loading="lazy">${entityLink(k, oid)}</span>`;
  if (kind === 'character') {
    if (info.corporation_id) sub.push(org('corporation', info.corporation_id));
    if (info.alliance_id) sub.push(org('alliance', info.alliance_id));
    if (info.birthday) sub.push('创建于 ' + new Date(info.birthday).toLocaleDateString('zh-CN'));
  } else {
    if (info.ticker) sub.push('[' + app.esc(info.ticker) + ']');
    if (info.member_count) sub.push(app.formatNumber(info.member_count) + ' 名成员');
    if (kind === 'corporation' && info.alliance_id) sub.push(org('alliance', info.alliance_id));
    if (info.date_founded) sub.push('成立于 ' + new Date(info.date_founded).toLocaleDateString('zh-CN'));
  }

  const card = (label, value, detail, cls = '') => `<div class="valuation-card ${cls}"><span class="valuation-label">${label}</span><strong class="valuation-value">${value}</strong><span class="valuation-detail">${detail}</span></div>`;
  const isk = (v) => app.formatISK(v) + '<span class="unit">ISK</span>';
  let lifetimeCards = '';
  if (lifetime && lifetime.shipsDestroyed !== undefined) {
    const lEff = (lifetime.iskDestroyed || 0) + (lifetime.iskLost || 0) ? lifetime.iskDestroyed / (lifetime.iskDestroyed + lifetime.iskLost) * 100 : null;
    lifetimeCards = `<h4 class="info-section-title">生涯统计<small>（zKillboard 估值）</small></h4><div class="valuation-grid">
      ${card('参与击杀', app.formatNumber(lifetime.shipsDestroyed || 0) + '<span class="unit">艘</span>', '单刷 ' + app.formatNumber(lifetime.soloKills || 0) + ' 次', 'is-buy')}
      ${card('损失', app.formatNumber(lifetime.shipsLost || 0) + '<span class="unit">艘</span>', '单刷被杀 ' + app.formatNumber(lifetime.soloLosses || 0) + ' 次', 'is-sell')}
      ${card('击毁价值', isk(lifetime.iskDestroyed || 0), '', 'is-buy')}
      ${card('损失价值', isk(lifetime.iskLost || 0), '', 'is-sell')}
      ${card('ISK 效率', lEff == null ? '—' : lEff.toFixed(1) + '%', '危险度 ' + (lifetime.dangerRatio ?? '—') + '% · 团战 ' + (lifetime.gangRatio ?? '—') + '%', 'is-total')}
    </div>`;
  }
  const recentCards = `<h4 class="info-section-title${lifetimeCards ? ' section-gap' : ''}">最近 30 天<small>（${VALUE_LABEL}）</small></h4><div class="valuation-grid">
      ${card('参与击杀', app.formatNumber(stats.kills) + '<span class="unit">次</span>', '单刷 ' + app.formatNumber(stats.solo_kills) + ' 次', 'is-buy')}
      ${stats.final_blows != null ? card('最后一击', app.formatNumber(stats.final_blows) + '<span class="unit">次</span>', stats.kills ? '占参与击杀 ' + (stats.final_blows / stats.kills * 100).toFixed(0) + '%' : '', 'is-buy') : ''}
      ${card('损失', app.formatNumber(stats.losses) + '<span class="unit">次</span>', '', 'is-sell')}
      ${card('击毁总价值', isk(stats.destroyed), '', 'is-buy')}
      ${card('损失总价值', isk(stats.lost), '', 'is-sell')}
      ${card('ISK 效率', eff == null ? '—' : eff.toFixed(1) + '%', '', 'is-total')}
    </div>`;

  const shipList = (list, title) => list.length ? `<section class="kb-mini-panel"><h5>${title}</h5>${list.map((s) =>
    `<div class="kb-mini-row"><img src="${IMG(`types/${s.ship_type_id}/icon`, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(typeName(s.ship_type_id))}</span><b>${s.count}</b></div>`).join('')}</section>` : '';
  const activity = activityHtml(stats);
  const corpHistory = kind === 'character' ? corpHistoryHtml(history) : '';

  return {
    head: `<div class="kb-entity-head">
      <img src="${avatar(kind, id, 128)}" alt="" width="72" height="72">
      <div>
        <span class="kb-entity-kind">${KIND_ZH[kind]}</span>
        <h2 translate="no">${stOf(kind === 'character' ? { character_id: Number(id), corporation_id: info.corporation_id, alliance_id: info.alliance_id }
          : kind === 'corporation' ? { corporation_id: Number(id), alliance_id: info.alliance_id } : { alliance_id: Number(id) })}${app.esc(name)}</h2>
        <p>${sub.join(' · ')}</p>
      </div>
      <div class="kb-ext-links">
        ${IS_TQ ? `<a class="btn btn-ghost" href="https://zkillboard.com/${kind}/${id}/" target="_blank" rel="noopener">zKillboard ↗</a>
        <a class="btn btn-ghost" href="https://evewho.com/${kind}/${id}" target="_blank" rel="noopener">EVEWho ↗</a>` : ''}
        ${!IS_TQ && SERVER.kbSite ? `<a class="btn btn-ghost" href="${kbSiteLink({ character: 'pilot', corporation: 'corp', alliance: 'alliance' }[kind], id)}" target="_blank" rel="noopener">${app.esc(SERVER.kbSite.name)} ↗</a>` : ''}
        ${IS_TQ && kind !== 'character' ? `<a class="btn btn-ghost" href="https://evemaps.dotlan.net/${kind === 'alliance' ? 'alliance' : 'corp'}/${encodeURIComponent(name.replace(/ /g, '_'))}" target="_blank" rel="noopener">dotlan ↗</a>` : ''}
      </div>
    </div>`,
    lifetime: lifetimeCards, recent: recentCards, activity, corpHistory,
    ships: `<div class="kb-mini-grid">${shipList(stats.ships_used, '常用舰船（击杀时）')}${shipList(stats.ships_lost, '损失的舰船')}</div>`
  };
}

// 最近 30 天活跃地区：星域（占比条）+ 星系（安全等级着色），点击可筛选击杀记录
// zKillboard 统计：最近 12 个月的击杀 / 损失（柱状，舰船数 / ISK 切换）与活跃时段（星期 × 小时热力图）；图表在 kb-charts.js
function monthlyHtml(z) {
  if (!z) return '';
  const months = monthList(z);
  let out = '';
  if (months.length) out += `<h4 class="info-section-title section-gap">月度统计<small>（zKillboard · 最近 ${months.length} 个月）</small></h4>${monthsChart(months)}`;
  if (z.activity?.max) out += `<h4 class="info-section-title section-gap">活跃时段<small>（zKillboard 全部记录）</small></h4>${heatChart()}`;
  return out;
}
const monthList = (z) => Object.values(z?.months || {}).sort((a, b) => (a.year - b.year) || (a.month - b.month)).slice(-12);
// 图表在 HTML 放进页面后再画（要量容器宽度）
function mountMonthly(root, z) {
  if (!z) return;
  const months = monthList(z);
  if (months.length) drawMonths(root, months);
  if (z.activity?.max) drawHeat(root, z.activity);
}

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
  return `<h4 class="info-section-title section-gap">最近 30 天活跃地区</h4>
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

// ---------- 搜索：人物 / 军团 / 联盟（服务端）+ 舰船 / 星系 / 星座 / 星域（本地）----------
let searchSeq = 0;
async function runSearch(text) {
  const box = $('kbSuggest');
  const q = text.trim().toLowerCase();
  if (q.length < 2) { ++searchSeq; renderHistory(); return; }
  const seq = ++searchSeq;
  const local = localSearch(q);
  renderSuggest({ ...local, entities: null });
  let entities = [];
  try { entities = (await api('search?q=' + encodeURIComponent(q))).results; } catch { /* 服务不可用时只显示本地结果 */ }
  if (seq !== searchSeq) return;
  renderSuggest({ ...local, entities });
  // 补上人物所属军团 / 联盟（图标 + 名字提示），查到后再画一次
  const chars = entities.filter((e) => e.category === 'character').slice(0, 6).map((e) => e.id);
  if (!chars.length) return;
  const aff = await ST.affiliation(chars, { sure: true }).catch(() => null);
  if (!aff || seq !== searchSeq) return;
  const orgs = [...aff.values()].flatMap((a) => [a.corp, a.alliance]).filter((x) => x && !app.officialName(x) && !S.names.has(x));
  if (orgs.length) { try { const named = await app.resolveNames(orgs); for (const [k, v] of named.names) S.names.set(k, v); } catch { /* 只显示图标 */ } }
  if (seq !== searchSeq) return;
  renderSuggest({ ...local, entities, aff });
}

// 搜索历史：点过的建议项（人物 / 军团 / 联盟 / 舰船 / 星系 / 星座 / 星域），存在本机，输入框为空时显示
const HIST_KEY = 'eve-kb-search-hist', HIST_MAX = 12;
function loadHistory() {
  try { const v = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch { /* 隐私模式等 */ }
}
function pushHistory(attr, value, name) {
  if (!name) return;
  saveHistory([{ a: attr, v: value, n: name }, ...loadHistory().filter((h) => !(h.a === attr && h.v === value))]);
}
function renderHistory() {
  const box = $('kbSuggest');
  const list = loadHistory();
  if (!list.length) { box.hidden = true; return; }
  const row = (h, i) => {
    let icon = '<i></i>', tag = '';
    if (h.a === 'entity') { const [kind, id] = h.v.split(':'); icon = `<img src="${avatar(kind, id, 32)}" alt="" width="22" height="22" loading="lazy">`; tag = KIND_ZH[kind] || ''; }
    else if (h.a === 'ship') { icon = `<img src="${IMG(`types/${h.v}/icon`, 32)}" alt="" width="22" height="22" loading="lazy">`; tag = '舰船'; }
    else {
      const [kind, id] = h.v.split(':');
      if (kind === 'system') { const l = kb.systemLabel(Number(id)); icon = `<i style="background:${l.color}"></i>`; tag = l.region || '星系'; }
      else tag = kind === 'region' ? '星域' : '星座';
    }
    const data = h.a === 'entity' ? `data-pick-entity="${app.esc(h.v)}"` : h.a === 'ship' ? `data-pick-ship="${app.esc(h.v)}"` : `data-pick-location="${app.esc(h.v)}"`;
    return `<div class="kb-suggest-row"><button class="kb-suggest-item" ${data}>${icon}<span>${app.esc(h.n)}</span><small>${app.esc(tag)}</small></button>
      <button class="kb-hist-del" data-hist-del="${i}" title="从搜索历史删除" aria-label="删除">×</button></div>`;
  };
  box.innerHTML = `<div class="kb-suggest-group kb-hist-head"><span>最近搜索</span><button data-hist-clear>清空</button></div>${list.map(row).join('')}`;
  box.hidden = false;
}

function localSearch(q) {
  const score = (name) => { const l = name.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : -1; };
  const pick = (list, n) => list.map((x) => ({ ...x, s: score(x.name) })).filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length).slice(0, n);
  const npc = app.getNpcNames();
  const systems = npc ? Object.entries(npc.systems).map(([id, name]) => ({ id: Number(id), name })) : [];
  const constellations = npc?.constellations ? Object.entries(npc.constellations).map(([id, name]) => ({ id: Number(id), name })) : [];
  const regions = npc ? Object.entries(npc.regions).map(([id, name]) => ({ id: Number(id), name })) : [];
  return { ships: pick(app.shipTypes(), 6), systems: pick(systems, 6), constellations: pick(constellations, 4), regions: pick(regions, 4) };
}

function renderSuggest({ entities, ships, systems, constellations, regions, aff }) {
  const box = $('kbSuggest');
  const group = (title, items) => items.length ? `<div class="kb-suggest-group">${title}</div>` + items.join('') : '';
  const ents = entities || [];
  const orgIcon = (k, oid) => oid ? `<img class="kb-suggest-org" src="${avatar(k, oid, 32)}" alt="" width="18" height="18" loading="lazy" title="${app.esc((k === 'alliance' ? '联盟：' : '军团：') + partyName(oid))}">` : '';
  const orgsOf = (kind, id) => { const a = kind === 'character' ? aff?.get(id) : null; return a ? orgIcon('corporation', a.corp) + orgIcon('alliance', a.alliance) : ''; };
  const byKind = (kind) => ents.filter((e) => e.category === kind).slice(0, 6).map((e) =>
    `<div class="kb-suggest-row"><button class="kb-suggest-item" data-pick-entity="${kind}:${e.id}"><img src="${avatar(kind, e.id, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(e.name)}</span>${orgsOf(kind, e.id)}<small>${KIND_ZH[kind]}统计</small></button>
      <button class="kb-suggest-add" data-add-entity="${kind}:${e.id}" data-name="${app.esc(e.name)}" title="加入击杀列表筛选（可以选多个）">＋ 筛选</button></div>`);
  const html =
    (entities === null ? '<div class="kb-suggest-group">人物 / 军团 / 联盟 · 搜索中…</div>' :
      group('人物', byKind('character')) + group('军团', byKind('corporation')) + group('联盟', byKind('alliance'))) +
    group('舰船', ships.map((s) => `<button class="kb-suggest-item" data-pick-ship="${s.id}"><img src="${IMG(`types/${s.id}/icon`, 32)}" alt="" width="22" height="22" loading="lazy"><span>${app.esc(s.name)}</span><small>筛选击杀记录</small></button>`)) +
    group('星系', systems.map((s) => { const l = kb.systemLabel(s.id); return `<button class="kb-suggest-item" data-pick-location="system:${s.id}"><i style="background:${l.color}"></i><span>${app.esc(s.name)} <b style="color:${l.color}">${l.secText}</b></span><small>${app.esc(l.region)}</small></button>`; })) +
    group('星座', constellations.map((r) => `<button class="kb-suggest-item" data-pick-location="constellation:${r.id}"><i></i><span>${app.esc(r.name)}</span></button>`)) +
    group('星域', regions.map((r) => `<button class="kb-suggest-item" data-pick-location="region:${r.id}"><i></i><span>${app.esc(r.name)}</span></button>`));
  box.innerHTML = html || '<p class="legend-empty">没有找到匹配项</p>';
  box.hidden = false;
}

// ---------- 路由：#kb、#kb/character/ID、#kb/corporation/ID、#kb/alliance/ID、#kb/br、#kb/rank、#kb/battles ----------
function navigate(hash) {
  if (location.hash !== hash) history.pushState(null, '', hash);
  route();
}

let routed = false;
function route() {
  routed = true;
  noteTrail();
  const m = /^#kb\/(character|corporation|alliance)\/(\d+)/.exec(location.hash);
  $('kbSuggest').hidden = true;
  document.querySelector('#kbView .kb-scroll')?.scrollTo({ top: 0 });
  if (location.hash.startsWith('#kb/br')) { S.entity = null; renderBr(location.hash); }
  else if (location.hash.startsWith('#kb/local')) { S.entity = null; renderLocalScan(); }
  else if (location.hash.startsWith('#kb/rank')) renderRank(location.hash);
  else if (location.hash.startsWith('#kb/battles')) renderBattleHistory();
  else if (m) renderEntity(m[1], Number(m[2]));
  else {
    renderHome();
    // 击杀分享图片的二维码：#kb/kill/<id> 打开这条击杀，地址换回击杀记录首页
    const kill = /^#kb\/kill\/(\d+)/.exec(location.hash);
    if (kill) { history.replaceState(null, '', '#kb'); openKill(Number(kill[1])); }
  }
}

// ---------- 本地分析：频道成员名单 / 定向扫描（local-scan.js，首次打开时加载）----------
async function renderLocalScan() {
  const m = await import('./local-scan.js?v=v18');
  if (!location.hash.startsWith('#kb/local')) return;
  m.renderLocal($('kbMain'), {
    esc: app.esc, formatISK: app.formatISK, formatNumber: app.formatNumber, resolveNames: app.resolveNames, esiUrl: app.esiUrl, eveImage: IMG,
    kb: true, server: IS_TQ ? '' : SERVER.id, back: backLink(), loadTypes, typeName, systemName: (id) => kb.systemLabel(id).name, fetchESI: app.fetchESI, copyText: app.copyText, nearest: kb.nearestOf
  });
}

// ---------- 入口 ----------
let started = false;

function homeSkeleton() {
  return `<section class="kb-summary">${skSummary()}</section>
    <section class="kb-section">${skTitle(14)}<div class="kb-top">${skTopCards(14)}</div></section>
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
  const paths = ['summary?hours=24', 'status', 'top?days=7&limit=14', 'feed?' + feedQuery(),
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
  initKbCharts(app);
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
    if (key === 'min') battles.setBattleSettings({ min: el.value });
  });
  const input = $('kbSearch');
  input.addEventListener('input', app.debounce(() => runSearch(input.value), 200));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; $('kbSuggest').hidden = true; }
    if (e.key === 'Enter' && input.value.trim().length >= 2) { $('kbSuggest').querySelector('.kb-suggest-item')?.click(); e.preventDefault(); }
  });
  input.addEventListener('focus', () => runSearch(input.value));
  // 记下点过的建议项（在击杀页总的点击处理之前），历史里的删除 / 清空按钮也在这里处理
  $('kbSuggest').addEventListener('click', (e) => {
    const del = e.target.closest('[data-hist-del]');
    if (del || e.target.closest('[data-hist-clear]')) {
      e.stopPropagation();
      saveHistory(del ? loadHistory().filter((_, i) => i !== Number(del.dataset.histDel)) : []);
      renderHistory();
      input.focus();
      return;
    }
    const it = e.target.closest('[data-pick-entity], [data-add-entity], [data-pick-ship], [data-pick-location]');
    if (!it) return;
    const name = it.dataset.name || it.querySelector('span')?.firstChild?.textContent.trim();
    if (it.dataset.pickShip) pushHistory('ship', it.dataset.pickShip, name);
    else if (it.dataset.pickLocation) pushHistory('loc', it.dataset.pickLocation, name);
    else pushHistory('entity', it.dataset.pickEntity || it.dataset.addEntity, name);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.kb-search')) $('kbSuggest').hidden = true; });

  $('kbView').addEventListener('click', (e) => {
    const addEnt = e.target.closest('[data-add-entity]');
    if (addEnt) {
      const [kind, id] = addEnt.dataset.addEntity.split(':');
      input.value = '';
      $('kbSuggest').hidden = true;
      setFilter('ents', 'add', { kind, id: Number(id), name: addEnt.dataset.name });
      return;
    }
    const entity = e.target.closest('[data-entity], [data-pick-entity]');
    if (entity) {
      e.preventDefault();
      const [kind, id] = (entity.dataset.entity || entity.dataset.pickEntity).split(':');
      input.value = '';
      navigate(`#kb/${kind}/${id}`);
      return;
    }
    if (e.target.closest('[data-entity-share]')) { shareEntity(); return; }
    if (e.target.closest('[data-entity-tofeed]')) { $('kbEntityFeedHead')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (e.target.closest('[data-kb-br]')) { navigate('#kb/br'); return; }
    if (e.target.closest('[data-kb-local]')) { navigate('#kb/local'); return; }
    if (e.target.closest('[data-kb-bh]')) { e.preventDefault(); navigate('#kb/battles'); return; }
    const bh = e.target.closest('[data-bh]');
    if (bh && S.bh) {
      const [key, value] = bh.dataset.bh.split(':');
      S.bh[key] = key === 'sec' ? value : Number(value);
      S.bh.shown = BH_PAGE;
      drawBhControls(); drawBh();
      return;
    }
    if (e.target.closest('[data-pb-more]') && S.entity?.pb) { S.entity.pb.shown += PB_PAGE; drawPilotBattles(); return; }
    if (e.target.closest('[data-bh-more]') && S.bh) { S.bh.shown += BH_PAGE; drawBh(); return; }
    if (e.target.closest('[data-kb-rank]')) { e.preventDefault(); navigate(rankHash({ ...S.lb, days: 30 })); return; }
    const rk = e.target.closest('[data-rank]');
    if (rk && S.rank) {
      const [key, value] = rk.dataset.rank.split(':');
      setRank({ [key]: key === 'days' ? Number(value) : value, page: 1 });
      return;
    }
    if (e.target.closest('[data-kb-rank-export]')) { exportRank(); return; }
    const pg = e.target.closest('[data-rank-page]');
    if (pg && S.rank && !pg.disabled) { setRank({ page: Number(pg.dataset.rankPage) }); return; }
    let brBattle = e.target.closest('[data-br-battle]');
    // 整块卡片：点到卡片里的链接、按钮、输入框时交给它们自己；选中文字时不跳转
    if (brBattle?.hasAttribute('data-br-card') && (e.target.closest('a, button, input, select, label, [data-kill], [data-location]') || String(window.getSelection?.() || ''))) brBattle = null;
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
    if (e.target.closest('[data-battle-push]')) { app.openPush(); return; }
    const loc = e.target.closest('[data-location], [data-pick-location]');
    if (loc) {
      e.preventDefault();
      const [kind, id] = (loc.dataset.location || loc.dataset.pickLocation).split(':');
      const name = kind === 'system' ? kb.systemLabel(Number(id)).name : partyName(Number(id));
      input.value = '';
      $('kbSuggest').hidden = true;
      setFilter('locs', loc.dataset.pickLocation ? 'add' : 'set', { kind, id: Number(id), name });
      return;
    }
    const ship = e.target.closest('[data-pick-ship]');
    if (ship) {
      const id = Number(ship.dataset.pickShip);
      input.value = '';
      $('kbSuggest').hidden = true;
      setFilter('ships', 'add', { id, name: app.shipTypes().find((s) => s.id === id)?.name || typeName(id) });
      return;
    }
    const gd = e.target.closest('[data-gank-days]');
    if (gd) { S.gank.days = Number(gd.dataset.gankDays); loadGank(); return; }
    const fine = e.target.closest('[data-fine]');
    if (fine) { setFine(fine.dataset.fine); return; }
    const clear = e.target.closest('[data-clear-filter]');
    if (clear) { const [key, id] = clear.dataset.clearFilter.split(':'); setFilter(key, 'remove', Number(id)); return; }
    if (e.target.closest('[data-kb-home]')) {
      e.preventDefault();
      if (trail.length > 1) history.back();   // popstate → route()，trail 在 noteTrail 里退一格
      else navigate('#kb');
      return;
    }
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
    if (S.bh && location.hash.startsWith('#kb/battles') && e.target.matches('[data-bh-region], [data-bh-sort]')) {
      S.bh[e.target.matches('[data-bh-region]') ? 'region' : 'sort'] = e.target.value;
      S.bh.shown = BH_PAGE;
      drawBh();
      return;
    }
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
