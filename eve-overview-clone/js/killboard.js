// ===== 击杀记录（KB）=====
// 数据来源：zKillboard 公开 API（https://zkillboard.com/api/），浏览器可直接请求（CORS: *），无需授权。
// 一次请求即返回完整击杀邮件（受害者、攻击者、物品）及 zKill 估值（zkb）。
// 按 zKillboard 的使用约定：请求串行、间隔发送，结果缓存 5 分钟。
import { SERVER, NO_KB_MESSAGE, serverKey, esiUrl, eveImage } from './server.js?v=s4';
import { skCards, skRows, skEntityHead, skTitle } from './skeleton.js?v=v17';
import { fullIn } from './eve-time.js?v=v1';

let app;

const ZKILL = 'https://zkillboard.com/api/';
const CACHE_TTL = 5 * 60e3;
const MIN_GAP = 600;            // 两次请求的最小间隔（毫秒）
const cache = new Map();        // path -> { at, data }
let queue = Promise.resolve();
let lastRequest = 0;

const $ = (id) => document.getElementById(id);
const img = (path, size) => eveImage(path, size);

export function initKillboard(context) {
  app = context;
  $('killModal').addEventListener('click', (e) => {
    if (e.target.closest('.modal-backdrop, [data-close-kill]')) closeKill();
    // 人物 / 军团 / 联盟链接：关闭弹窗，地址栏切到 #kb/... 后由击杀记录页打开对应统计页
    if (e.target.closest('a[data-kb-entity]')) closeKill();
    const fit = e.target.closest('[data-kill-tab]');
    if (fit) switchKillTab(fit.dataset.killTab);
    // 去装配页查看：关闭弹窗，在模拟装配中打开这艘船与击杀时的装配
    const go = e.target.closest('[data-kill-fit]');
    if (go && shownKill && !go.disabled) {
      const kill = shownKill;
      go.disabled = true;
      app.openKillFit(kill).then((ok) => { if (ok) closeKill(); else go.disabled = false; });
    }
  });
  // 切换估值价格来源：重算交易中心估值后重绘（保留当前标签页）
  $('killModal').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-val-src]') || !shownArgs) return;
    app.valuation.set(e.target.value);
    const args = shownArgs, tab = $('killBody').querySelector('[data-kill-tab].active')?.dataset.killTab;
    const val = await killValuation(args.kill);
    if (shownArgs !== args) return;
    $('killBody').innerHTML = renderKill(args.kill, val, args.priceNote, args.insurance);
    if (tab) switchKillTab(tab);
  });
}

// 船体 + 全部物品（含货柜内）按所选交易中心的最低卖 / 最高收估值；singleton 2 为蓝图副本
function killValuation(kill) {
  const list = [{ type_id: kill.victim.ship_type_id, quantity: 1 }];
  const walk = (items) => { for (const it of items || []) { list.push({ type_id: it.item_type_id, quantity: (it.quantity_dropped || 0) + (it.quantity_destroyed || 0), is_blueprint_copy: it.singleton === 2 }); walk(it.items); } };
  walk(kill.victim.items);
  return app.valuation.items(list);
}

// ---------- 请求 ----------
export function fetchZkill(path) {
  if (!SERVER.kb) return Promise.reject(new Error(NO_KB_MESSAGE));
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.data);
  const job = queue.then(async () => {
    const again = cache.get(path);
    if (again && Date.now() - again.at < CACHE_TTL) return again.data;
    const wait = Math.max(0, lastRequest + MIN_GAP - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(ZKILL + path);
    if (!res.ok) throw new Error('zKillboard ' + res.status);
    const text = await res.text();
    const data = text ? JSON.parse(text) : [];
    cache.set(path, { at: Date.now(), data });
    return data;
  });
  queue = job.catch(() => {});
  return job;
}

// ---------- 名称与星系信息 ----------
let mapData = null;
async function loadSystems() {
  if (!mapData) {
    mapData = fetch(SERVER.mapData).then((r) => r.json()).then((d) => {
      const regions = new Map(d.regions.map(([id, name]) => [id, name]));
      const systems = new Map(d.systems.map((s) => [s[0], { sec: s[5], region: regions.get(s[6]) || '', nbr: [] }]));
      // 星门连接（gates 为 systems 数组下标对），供战场统计选择邻近星系
      for (const [a, b] of d.gates || []) {
        const sa = d.systems[a]?.[0], sb = d.systems[b]?.[0];
        if (sa && sb) { systems.get(sa).nbr.push(sb); systems.get(sb).nbr.push(sa); }
      }
      const factions = new Map(Object.entries(d.factions).map(([id, f]) => [Number(id), f.name]));
      return { systems, factions };
    }).catch(() => ({ systems: new Map(), factions: new Map() }));
  }
  return mapData;
}

const names = new Map();       // 玩家角色/军团/联盟（原名）
const typeNames = new Map();
let systemTable = new Map();
let factionTable = new Map();   // NPC 阵营中文名（攻击者可能是阵营 NPC）

// 为击杀列表准备名称：官方中文（NPC、星系、物品）+ 玩家原名
export async function prepareKills(kills, { attackers = 'final' } = {}) {
  await app.loadNpcNames();
  const loaded = await loadSystems();
  systemTable = loaded.systems;
  factionTable = loaded.factions;
  const parties = new Set();
  const types = new Set();
  for (const k of kills) {
    const v = k.victim;
    [v.character_id, v.corporation_id, v.alliance_id].forEach((id) => id && parties.add(id));
    types.add(v.ship_type_id);
    const list = attackers === 'all' ? k.attackers : k.attackers.filter((a) => a.final_blow);
    for (const a of list) {
      [a.character_id, a.corporation_id, a.alliance_id].forEach((id) => id && parties.add(id));
      if (a.ship_type_id) types.add(a.ship_type_id);
      if (a.weapon_type_id) types.add(a.weapon_type_id);
    }
    if (attackers === 'all') collectItems(v.items || [], types);
  }
  const unknown = [...parties].filter((id) => !names.has(id) && !app.officialName(id) && !factionTable.has(id));
  if (unknown.length) {
    const named = await app.resolveNames(unknown);
    for (const [k, v] of named.names) names.set(k, v);
  }
  const missingTypes = [...types].filter((t) => t && !typeNames.has(t));
  if (missingTypes.length) {
    const resolved = await app.resolveTypeNames(missingTypes);
    for (const [k, v] of resolved) typeNames.set(k, v);
  }
}

function collectItems(items, types) {
  for (const it of items) {
    types.add(it.item_type_id);
    if (it.items) collectItems(it.items, types);
  }
}

// NPC 军团（1000000–1999999）与阵营在击杀记录页没有统计页，不加链接
const linkable = (kind, id) => id && (kind !== 'corporation' || id < 1000000 || id >= 2000000);
const partyLink = (kind, id, text) => {
  const label = app.esc(text ?? partyName(id));
  return linkable(kind, id) ? `<a class="kb-link" href="#kb/${kind}/${id}" data-kb-entity="${kind}:${id}">${label}</a>` : label;
};

const partyName = (id) => (id ? app.officialName(id) || factionTable.get(id) || names.get(id) || 'ID ' + id : '');
const typeName = (id) => typeNames.get(id) || 'Type ' + id;

// 供击杀记录页复用：确保星系安全等级 / 星域数据已加载
export async function ensureSystems() {
  await app.loadNpcNames();
  const loaded = await loadSystems();
  systemTable = loaded.systems;
  factionTable = loaded.factions;
}

// 星门跳数 ≤ maxJumps 的邻近星系（不含自身），按跳数排序：[{ id, jumps }]
export function systemNeighbors(id, maxJumps = 1) {
  const seen = new Map([[id, 0]]);
  let frontier = [id];
  for (let j = 1; j <= maxJumps; j++) {
    const next = [];
    for (const s of frontier) for (const n of systemTable.get(s)?.nbr || []) if (!seen.has(n)) { seen.set(n, j); next.push(n); }
    frontier = next;
  }
  seen.delete(id);
  return [...seen].map(([sid, jumps]) => ({ id: sid, jumps }));
}

export function systemLabel(id) {
  const sys = systemTable.get(id);
  const name = app.officialName(id) || '星系 ' + id;
  if (!sys) return { name, sec: null, secText: '虫洞', color: '#9b7bd4', region: '' };
  const d = sys.sec > 0 && sys.sec < 0.05 ? 0.1 : Math.max(0, Math.round(sys.sec * 10) / 10);
  const color = d >= 0.5 ? 'var(--buy-color)' : d > 0 ? 'var(--warning)' : 'var(--sell-color)';
  return { name, sec: d, secText: d.toFixed(1), color, region: sys.region };
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 3600e3) return Math.max(1, Math.floor(diff / 60e3)) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  if (diff < 86400e3 * 30) return Math.floor(diff / 86400e3) + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN');
}

// 击杀时间：北京时间（UTC+8）为主，下面一行是游戏内时间（EVE 时间 = UTC）
function killTime(iso) {
  const sec = Math.floor(Date.parse(iso) / 1000);
  if (!Number.isFinite(sec)) return '—';
  return `${fullIn(sec, 'cn')} <small class="kb-tz">UTC+8</small><br><small class="text-muted">游戏内时间 ${fullIn(sec, 'eve')}</small>`;
}

function killTags(z) {
  const tags = [];
  if (z.solo) tags.push('<span class="kb-tag solo">单刷</span>');
  if (z.npc) tags.push('<span class="kb-tag npc">NPC</span>');
  if (z.awox) tags.push('<span class="kb-tag awox">误伤</span>');
  return tags.join('');
}

// ---------- 列表 ----------
// 表格行：me 为角色 ID 时标注「击杀 / 损失」
export function killTableHtml(kills, { me = null, showSide = false } = {}) {
  if (!kills.length) return '<p class="text-muted kb-empty">没有击杀记录</p>';
  const rows = kills.map((k) => {
    const v = k.victim;
    const fb = k.attackers.find((a) => a.final_blow) || k.attackers[0] || {};
    const sys = systemLabel(k.solar_system_id);
    const loss = me != null && v.character_id === me;
    return `<tr class="kb-row" data-kill="${k.killmail_id}" tabindex="0">
        ${showSide ? `<td class="kb-side"><span class="pill ${loss ? 'sell' : 'buy'}">${loss ? '损失' : '击杀'}</span></td>` : ''}
        <td class="kb-ship"><span class="kb-ship-inner"><img src="${img(`types/${v.ship_type_id}/icon`, 64)}" alt="" width="32" height="32" loading="lazy">
          <span><strong>${app.esc(typeName(v.ship_type_id))}</strong>${killTags(k.zkb)}</span></span></td>
        <td class="kb-party kb-victim-cell"><strong>${app.esc(partyName(v.character_id) || partyName(v.corporation_id))}</strong>
          <span class="cell-sub">${app.esc(partyName(v.corporation_id))}${v.alliance_id ? ' · ' + app.esc(partyName(v.alliance_id)) : ''}</span></td>
        <td class="kb-party kb-final-cell"><strong>${app.esc(partyName(fb.character_id) || typeName(fb.ship_type_id))}</strong>
          <span class="cell-sub">${k.attackers.length} 名攻击者</span></td>
        <td class="kb-loc"><strong>${app.esc(sys.name)} <span style="color:${sys.color}">${sys.secText}</span></strong>
          <span class="cell-sub">${app.esc(sys.region)}</span></td>
        <td class="num kb-value"><strong>${app.formatISK(k.zkb.totalValue)}</strong><span class="cell-sub">${timeAgo(k.killmail_time)}</span></td>
      </tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="pc-mini-table kb-table"><thead><tr>
      ${showSide ? '<th>类型</th>' : ''}<th>舰船</th><th>受害者</th><th>最后一击</th><th>地点</th><th class="num">价值</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

// 紧凑列表（星图详情面板）
export function killCompactHtml(kills) {
  if (!kills.length) return '<p class="legend-empty">最近没有击杀记录</p>';
  return kills.map((k) => `<button class="kb-item" data-kill="${k.killmail_id}">
      <img src="${img(`types/${k.victim.ship_type_id}/icon`, 64)}" alt="" width="30" height="30" loading="lazy">
      <span class="kb-item-text"><strong>${app.esc(typeName(k.victim.ship_type_id))}</strong>
        <small>${app.esc(partyName(k.victim.character_id) || partyName(k.victim.corporation_id))}</small></span>
      <span class="kb-item-meta"><b>${app.formatISK(k.zkb.totalValue)}</b><small>${timeAgo(k.killmail_time)}</small></span>
    </button>`).join('');
}

// 列表点击 → 详情；kills 用于按 ID 查找
export function bindKillClicks(container, kills) {
  const byId = new Map(kills.map((k) => [k.killmail_id, k]));
  const open = (el) => { const k = byId.get(Number(el.dataset.kill)); if (k) openKill(k); };
  container.addEventListener('click', (e) => { const el = e.target.closest('[data-kill]'); if (el && container.contains(el)) open(el); });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target.closest('[data-kill]');
    if (el) open(el);
  });
}

// ---------- 详情 ----------
// ESI 物品栏位编号 → 装配分组
const SLOT_GROUPS = [
  ['high', '高槽', (f) => f >= 27 && f <= 34],
  ['mid', '中槽', (f) => f >= 19 && f <= 26],
  ['low', '低槽', (f) => f >= 11 && f <= 18],
  ['rig', '改装件', (f) => f >= 92 && f <= 99],
  ['sub', '子系统', (f) => f >= 125 && f <= 132],
  ['drone', '无人机舱', (f) => f === 87],
  ['fighter', '铁骑舰载机库', (f) => f === 158 || (f >= 159 && f <= 163)],
  ['implant', '植入体', (f) => f === 89],
  ['cargo', '货舱', (f) => f === 5],
  ['other', '其他舱室', () => true]
];

function slotGroup(flag) {
  return SLOT_GROUPS.find(([, , test]) => test(flag))[0];
}

let currentKill = null;
let shownKill = null;   // 弹窗中正在显示的击杀
let shownArgs = null;   // 重绘所需：{ kill, priceNote, insurance }

// options.priceNote：总价值的估值说明（单项按所选交易中心估值）
// options.load：异步加载击杀数据（先打开弹窗显示加载状态）
export async function openKill(kill, options = {}) {
  const token = {};
  currentKill = token;
  shownKill = null;
  shownArgs = null;
  const modal = $('killModal');
  const body = $('killBody');
  modal.hidden = false;
  body.innerHTML = skEntityHead() + skCards(3) + skTitle(12) + skRows(8, { img: 24 });
  try {
    if (options.load) ({ kill, prices: options.prices } = await options.load());
    if (currentKill !== token) return;
    const [val, insurance] = await Promise.all([killValuation(kill), app.getInsurance?.().catch(() => null), prepareKills([kill], { attackers: 'all' })]);
    if (currentKill !== token) return;
    shownArgs = { kill, priceNote: options.priceNote, insurance: insurance?.get(kill.victim.ship_type_id) };
    body.innerHTML = renderKill(kill, val, shownArgs.priceNote, shownArgs.insurance);
    shownKill = kill;
  } catch (error) {
    if (currentKill === token) body.innerHTML = '<p class="text-muted kb-empty">击杀详情读取失败：' + app.esc(error.message) + '</p>';
    return;
  }
  $('killTitle').textContent = typeName(kill.victim.ship_type_id) + ' · 击杀详情';
}

// 打开击杀记录服务（/api/kb/）中的击杀：完整击杀邮件 + 逐项吉他中间价（星图弹幕等处使用）
const SERVICE_PRICE_NOTE = '总价值、掉落与摧毁价值按吉他海4 最低卖价与最高收购价的中间值估算（缺一侧时取另一侧，均无时取全服均价）。';
export function openServiceKill(id) {
  return openKill(null, {
    priceNote: SERVICE_PRICE_NOTE,
    load: async () => {
      if (!SERVER.kb) throw new Error(NO_KB_MESSAGE);
      const res = await fetch('/api/kb/kill/' + id);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '击杀记录服务 ' + res.status);
      for (const [k, v] of Object.entries(data.names || {})) if (v) names.set(Number(k), v);
      const km = data.killmail;
      const players = (km.attackers || []).filter((a) => a.character_id);
      return {
        kill: { ...km, zkb: { totalValue: data.value, droppedValue: data.dropped, destroyedValue: data.destroyed, solo: players.length === 1, npc: !players.length, awox: false, locationID: null, valueLabel: '吉他中间价估值' } },
        prices: new Map(Object.entries(data.prices).map(([k, v]) => [Number(k), v]))
      };
    }
  });
}

function closeKill() {
  $('killModal').hidden = true;
  currentKill = null;
  shownKill = null;
}

export function isKillOpen() {
  return !$('killModal').hidden;
}

export function closeKillModal() {
  closeKill();
}

function switchKillTab(tab) {
  $$('#killBody [data-kill-tab]').forEach((b) => b.classList.toggle('active', b.dataset.killTab === tab));
  $$('#killBody .kb-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
}
const $$ = (sel) => document.querySelectorAll(sel);

function itemRows(items, val, depth = 0) {
  return items.map((it) => {
    const qty = (it.quantity_dropped || 0) + (it.quantity_destroyed || 0);
    const p = it.singleton === 2 ? {} : val.price(it.item_type_id);
    const cell = (x) => (x == null ? '—' : app.formatISK(x * qty));
    const dropped = it.quantity_dropped ? `<span class="kb-dropped">掉落 ${app.formatNumber(it.quantity_dropped)}</span>` : '';
    const destroyed = it.quantity_destroyed ? `<span class="kb-destroyed">摧毁 ${app.formatNumber(it.quantity_destroyed)}</span>` : '';
    return `<div class="kb-fit-item${it.quantity_dropped ? ' is-dropped' : ''}" style="padding-left:${8 + depth * 18}px">
        <img src="${img(`types/${it.item_type_id}/icon`, 32)}" alt="" width="24" height="24" loading="lazy">
        <span class="kb-fit-name">${app.esc(typeName(it.item_type_id))}</span>
        <span class="kb-fit-qty">${dropped}${destroyed}</span>
        <span class="kb-fit-value" title="最低卖价">${cell(p.sell)}</span><span class="kb-fit-value is-buy" title="最高收购价">${cell(p.buy)}</span>
      </div>` + (it.items ? itemRows(it.items, val, depth + 1) : '');
  }).join('');
}

// 保险：不知道受害者投的哪一档，列出铂金（最高）赔付，净损失按铂金赔付估算（未投保时损失更大）
function insuranceHtml(levels, total) {
  levels = (levels || []).filter((l) => l.payout > 0);
  if (!levels.length) return '';
  const top = levels[levels.length - 1];
  const net = Math.max(0, total - (top.payout - top.cost));
  return `<div class="kb-insurance" title="${app.esc(levels.map((l) => `${l.name}：保费 ${app.formatISK(l.cost)} / 赔付 ${app.formatISK(l.payout)}`).join('\n'))}">
      <span>保险（${app.esc(top.name)}）赔付 <b>${app.formatISK(top.payout)}</b> · 保费 ${app.formatISK(top.cost)}</span>
      <span>投保后净损失约 <b>${app.formatISK(net)}</b></span></div>`;
}

function renderKill(k, val, priceNote, insurance) {
  const v = k.victim;
  const z = k.zkb;
  const sys = systemLabel(k.solar_system_id);
  const station = z.locationID && app.officialName(z.locationID);

  // 装配分组
  const groups = new Map(SLOT_GROUPS.map(([key, label]) => [key, { label, items: [] }]));
  for (const it of v.items || []) groups.get(slotGroup(it.flag)).items.push(it);
  const fit = [...groups.values()].filter((g) => g.items.length).map((g) =>
    `<section class="kb-fit-group"><h5>${g.label}<span>${g.items.length}</span></h5>${itemRows(g.items, val)}</section>`).join('')
    || '<p class="text-muted">没有物品</p>';

  // 攻击者
  const total = k.attackers.reduce((s, a) => s + (a.damage_done || 0), 0) || 1;
  const attackers = [...k.attackers].sort((a, b) => (b.final_blow - a.final_blow) || (b.damage_done - a.damage_done)).map((a) => {
    const avatar = a.character_id ? img(`characters/${a.character_id}/portrait`, 64)
      : a.corporation_id ? img(`corporations/${a.corporation_id}/logo`, 64)
        : a.faction_id ? img(`corporations/${a.faction_id}/logo`, 64) : img(`types/${a.ship_type_id}/icon`, 64);
    const who = partyName(a.character_id) || (a.ship_type_id ? typeName(a.ship_type_id) : partyName(a.corporation_id || a.faction_id));
    const pct = (a.damage_done || 0) / total * 100;
    return `<div class="kb-attacker${a.final_blow ? ' final' : ''}">
        <img class="kb-avatar" src="${avatar}" alt="" width="36" height="36" loading="lazy">
        <div class="kb-attacker-main">
          <strong>${a.character_id ? partyLink('character', a.character_id, who) : app.esc(who)}${a.final_blow ? '<span class="kb-tag final">最后一击</span>' : ''}</strong>
          <small>${a.corporation_id ? partyLink('corporation', a.corporation_id) : app.esc(partyName(a.faction_id))}${a.alliance_id ? ' · ' + partyLink('alliance', a.alliance_id) : ''}</small>
          <div class="kb-dmg"><i style="width:${pct.toFixed(1)}%"></i></div>
        </div>
        <div class="kb-attacker-gear">
          ${a.ship_type_id ? `<img src="${img(`types/${a.ship_type_id}/icon`, 32)}" title="${app.esc(typeName(a.ship_type_id))}" alt="" width="26" height="26" loading="lazy">` : ''}
          ${a.weapon_type_id && a.weapon_type_id !== a.ship_type_id ? `<img src="${img(`types/${a.weapon_type_id}/icon`, 32)}" title="${app.esc(typeName(a.weapon_type_id))}" alt="" width="26" height="26" loading="lazy">` : ''}
        </div>
        <div class="kb-attacker-dmg"><b>${app.formatNumber(a.damage_done)}</b><small>${pct.toFixed(1)}%</small></div>
      </div>`;
  }).join('');

  return `
    <div class="kb-head">
      <div class="kb-ship-col">
        <div class="kb-ship-render"><img src="${img(`types/${v.ship_type_id}/render`, 256)}" alt="" width="128" height="128"></div>
        <div class="kb-ship-actions">
          ${SERVER.kb ? `<a class="btn btn-ghost" href="https://zkillboard.com/kill/${k.killmail_id}/" target="_blank" rel="noopener">在 zKillboard 查看 ↗</a>` : ''}
        </div>
      </div>
      <div class="kb-victim">
        <div class="kb-victim-line">
          ${v.character_id ? `<img class="kb-avatar lg" src="${img(`characters/${v.character_id}/portrait`, 128)}" alt="" width="56" height="56">` : ''}
          <div>
            <h4>${v.character_id ? partyLink('character', v.character_id) : partyLink('corporation', v.corporation_id)}</h4>
            <p>${v.corporation_id ? `<img src="${img(`corporations/${v.corporation_id}/logo`, 32)}" alt="" width="16" height="16">${partyLink('corporation', v.corporation_id)}` : ''}
               ${v.alliance_id ? ` · <img src="${img(`alliances/${v.alliance_id}/logo`, 32)}" alt="" width="16" height="16">${partyLink('alliance', v.alliance_id)}` : ''}</p>
          </div>
        </div>
        <div class="kb-facts">
          <span><em>舰船</em>${app.esc(typeName(v.ship_type_id))}</span>
          <span><em>地点</em>${app.esc(sys.name)} <b style="color:${sys.color}">${sys.secText}</b>${sys.region ? ' · ' + app.esc(sys.region) : ''}${station ? '<br><small>' + app.esc(station) + '</small>' : ''}</span>
          <span><em>时间</em>${killTime(k.killmail_time)}</span>
          <span><em>伤害</em>${app.formatNumber(v.damage_taken)} · ${k.attackers.length} 名攻击者</span>
        </div>
        <div class="kb-tags">${killTags(z)}</div>
      </div>
      <div class="kb-values">
        <div class="kb-total"><span>总价值</span><strong>${app.formatISK(z.totalValue)}<small>ISK</small></strong></div>
        <div class="kb-split"><span class="kb-dropped">掉落 ${app.formatISK(z.droppedValue)}</span><span class="kb-destroyed">摧毁 ${app.formatISK(z.destroyedValue)}</span></div>
        <div class="kb-hubval">${app.valuation.select('data-val-src', val.region)}
          <span class="kb-hubval-row"><span>最低卖价 <b>${app.formatISK(val.sell)}</b></span><span>最高收价 <b>${app.formatISK(val.buy)}</b></span></span></div>
        ${insuranceHtml(insurance, z.totalValue)}
        ${k.zkb.valueLabel ? `<span class="kb-value-note">${app.esc(k.zkb.valueLabel)}</span>` : ''}
      </div>
    </div>
    ${app.openKillFit ? '<div class="kb-fit-cta"><button class="btn btn-primary" data-kill-fit title="在模拟装配中打开这艘船与击杀时的装配">去装配页查看</button></div>' : ''}
    <div class="segmented kb-tabs">
      <button data-kill-tab="fit" class="active">装配与物品</button>
      <button data-kill-tab="attackers">攻击者（${k.attackers.length}）</button>
    </div>
    <div class="kb-pane" data-pane="fit"><div class="kb-fit-cols"><span>最低卖价</span><span>最高收价</span></div>${fit}<p class="valuation-note" title="${app.esc(priceNote || (SERVER.kb ? '总价值为 zKillboard 估值' : '总价值按 ESI 全服均价估算'))}">按${app.esc(val.region.hub.name)}估值</p></div>
    <div class="kb-pane" data-pane="attackers" hidden>${attackers}</div>`;
}

// ---------- 常用装配（舰船近期损失统计）----------
// 返回每个槽位分组中出现频率最高的模块及其使用比例
export function commonFit(kills, top = 6) {
  const result = [];
  for (const [key, label] of SLOT_GROUPS.filter(([k]) => ['high', 'mid', 'low', 'rig', 'sub', 'drone'].includes(k))) {
    const counts = new Map();
    for (const k of kills) {
      const seen = new Set();
      for (const it of k.victim.items || []) if (slotGroup(it.flag) === key) seen.add(it.item_type_id);
      for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
    }
    if (!counts.size) continue;
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    result.push({ key, label, list: list.map(([type, n]) => ({ type, share: n / kills.length })) });
  }
  return result;
}

export async function prepareFitNames(kills) {
  const types = new Set();
  for (const k of kills) collectItems(k.victim.items || [], types);
  const missing = [...types].filter((t) => !typeNames.has(t));
  if (missing.length) {
    const resolved = await app.resolveTypeNames(missing);
    for (const [k, v] of resolved) typeNames.set(k, v);
  }
}

export function commonFitHtml(groups) {
  if (!groups.length) return '';
  return '<div class="kb-common">' + groups.map((g) => `<section><h5>${g.label}</h5>` + g.list.map(({ type, share }) =>
    `<div class="kb-common-row"><img src="${img(`types/${type}/icon`, 32)}" alt="" width="22" height="22" loading="lazy">
      <span>${app.esc(typeName(type))}</span><i style="--w:${(share * 100).toFixed(0)}%"></i><b>${(share * 100).toFixed(0)}%</b></div>`).join('') +
    '</section>').join('') + '</div>';
}
