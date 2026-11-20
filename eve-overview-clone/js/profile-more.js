// ===== 个人中心 · 克隆 / 挖矿 / 研究 / 舰队 / 军团 / 邮件 =====
//   克隆  /characters/{id}/clones/ + /implants/（esi-clones.*，原有权限）：跳跃克隆位置与植入体、下次可跳时间
//   挖矿  /characters/{id}/mining/（esi-industry.read_character_mining.v1，原有权限）：最近 30 天挖矿记录，按所选交易中心（或全宇宙）的最低卖 / 最高收估值
//   研究  /characters/{id}/agents_research/（「研究代理人」权限）：研究点数 = 余数 + 每日点数 × 开始以来的天数
//   舰队  /characters/{id}/fleet/ → /fleets/{fleet_id}/members/（「舰队」权限，读成员需要是舰队指挥）
//   军团  /characters/{id}/roles/ + 军团钱包 / 订单 / 工业 / 建筑 / 月矿 / 资产（「军团管理」权限，且需相应军团职位）
//         建筑：点开一行看装配——军团资产里装在建筑上的物品（总监，表格先出、装配后台读），按槽位列出，
//         并按 ind-rigs.json（SDE）算船体与改装件的工业加成（乘建筑所在星系的安全等级倍数）和化矿率；
//         「统一添油」（fuel-plan.js）：这次带的燃料块分给各建筑，让加完以后一起到期
// 数据按角色缓存 5 分钟，切换角色时清空。
import { skCards, skRows } from './skeleton.js?v=v18';
import * as ST from './standings.js?v=v6';
import * as IS from './ind-structs.js?v=6';
import * as FP from './fuel-plan.js?v=1';

let ctx;
const cache = new Map();   // `${tab}:${key}` -> { id, at, promise }
const TTL = 5 * 60e3;
const CORP_VIEWS = [
  ['wallets', '钱包', '会计 / 初级会计'], ['orders', '订单', '会计 / 交易员'], ['jobs', '工业任务', '工厂管理员'],
  ['structures', '建筑', '空间站管理员'], ['moons', '月矿', '空间站管理员'], ['assets', '资产', '总监']
];
const S = { corpView: 'wallets', fleetView: 'ships' };
const SF_OPEN = new Set();   // 军团建筑表里展开了装配的建筑
const SKILL_INFOMORPH = 33399;   // 意识同步：每级缩短跳跃克隆冷却 1 小时

export function initProfileMore(context) {
  ctx = context;
  FP.initFuelPlan({ ...context, left, fmtDate });
  window.addEventListener('eve-account-change', () => cache.clear());
}

const esc = (s) => ctx.esc(s);
const val0 = () => ctx.valuation.region();
const me = () => ctx.tokenInfo()?.character_id;
// 读取时显示骨架屏（与个人中心首次进入一致）；带进度的提示仍显示文字
const loading = (text = '') => (text && text !== '读取中…' ? `<div class="pi-loading">${esc(text)}</div>` : skCards(4) + skRows(8));
const fail = (what, error) => `<p class="text-muted">${esc(what)}读取失败：${esc(error.message)}</p>`;
const fmtDate = (iso, time = true) => iso ? new Date(iso).toLocaleString('zh-CN', time ? { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
function left(ms) {
  if (ms <= 0) return '现在';
  const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24), m = Math.floor((ms % 3600e3) / 60e3);
  return d ? `${d} 天 ${h % 24} 小时` : h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
}
function typeCell(names, id, qty) {
  return `<span class="trade-item"><img src="${ctx.gameImage('types/' + id + '/icon', 32)}" alt="" width="20" height="20" loading="lazy">${esc(names.get(Number(id)) || 'Type ' + id)}${qty ? ` <small class="text-muted">× ${ctx.formatNumber(qty)}</small>` : ''}</span>`;
}
const table = (head, rows, cls = '') => `<div class="table-scroll"><table class="pc-mini-table ${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const tr = (cells) => '<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>';

// 带缓存的读取：key 区分同一页面的不同数据
function cached(key, fn, id = me()) {
  if (id !== me()) key += '@' + id;   // 「全部角色」里其他角色的数据
  const hit = cache.get(key);
  if (hit && hit.id === id && Date.now() - hit.at < TTL) return hit.promise;
  const promise = fn(id);
  cache.set(key, { id, at: Date.now(), promise });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}
// 渲染前确认仍停留在该页、角色没变
const still = (tab, id) => ctx.isActive(tab) && me() === id;

// ---------- 全部角色：克隆 / 挖矿 / 研究按角色各一节，每节用单角色的渲染 ----------
const can = (id, scope) => (id === me() ? ctx.hasScope(scope) : ctx.allChars.can(id, scope));
const canGroup = (id, g) => (id === me() ? ctx.hasScopeGroup(g) : ctx.allChars.canGroup(id, g));
const get = (id, path) => (id === me() ? ctx.esiAuthFetch(path) : ctx.allChars.fetch(id, path));
const getPaged = (id, path, max) => (id === me() ? ctx.esiAuthFetchPaged(path, max) : ctx.allChars.paged(id, path, max));
const skillsOf = (id) => (id === me() ? ctx.getCharacterSkills()
  : get(id, '/characters/' + id + '/skills/').then((d) => ({ levels: new Map((d.skills || []).map((x) => [x.skill_id, x.active_skill_level])) })));
// one(el, id, alive)：把角色 id 的内容画进 el；alive() 为假时不再写入
async function perChar(tab, box, one) {
  const gen = (box.dataset.acGen = String(Number(box.dataset.acGen || 0) + 1));
  if (!ctx.allChars.on()) {
    const id = me();
    const bar = ctx.allChars.toggle();
    if (!bar) return one(box, id, () => still(tab, id));
    box.innerHTML = `<div class="valuation-toolbar"><span class="toolbar-spacer"></span>${bar}</div><div class="ac-body"></div>`;
    return one(box.lastElementChild, id, () => still(tab, id) && box.dataset.acGen === gen);
  }
  const list = ctx.allChars.list();
  box.innerHTML = `<div class="valuation-toolbar"><span class="toolbar-spacer"></span>${ctx.allChars.toggle()}</div>` +
    list.map((a) => `<section class="ac-group">${ctx.allChars.head(a)}<div class="ac-body" data-ac="${a.id}"></div></section>`).join('');
  await Promise.all(list.map((a) => one(box.querySelector(`[data-ac="${a.id}"]`), a.id, () => ctx.isActive(tab) && box.dataset.acGen === gen)));
}

// ---------- 克隆 ----------
const renderClones = (box) => perChar('clones', box, clonesOne);
async function clonesOne(box, id, alive) {
  if (!can(id, 'esi-clones.read_clones.v1')) { box.innerHTML = '<p class="text-muted" title="esi-clones.read_clones.v1">无克隆权限，需重新绑定 ESI</p>'; return; }
  box.innerHTML = loading('读取中…');
  let data;
  try {
    data = await cached('clones', async (cid) => {
      const [clones, implants, skills] = await Promise.all([
        get(cid, '/characters/' + cid + '/clones/'),
        can(cid, 'esi-clones.read_implants.v1') ? get(cid, '/characters/' + cid + '/implants/').catch(() => []) : Promise.resolve(null),
        skillsOf(cid).catch(() => null)
      ]);
      const types = await ctx.resolveTypeNames([...(implants || []), ...(clones.jump_clones || []).flatMap((c) => c.implants || [])]);
      const locs = [clones.home_location?.location_id, ...(clones.jump_clones || []).map((c) => c.location_id)].filter(Boolean);
      await ctx.resolveStructureNames(locs).catch(() => {});
      return { clones, implants, skills, types };
    }, id);
  } catch (error) { if (alive()) box.innerHTML = fail('克隆', error); return; }
  if (!alive()) return;
  const { clones, implants, skills, types } = data;
  const sync = skills?.levels?.get(SKILL_INFOMORPH) || 0;
  const cooldown = (24 - sync) * 3600e3;
  const last = clones.last_clone_jump_date ? new Date(clones.last_clone_jump_date).getTime() : 0;
  const next = last + cooldown;
  const stationChange = clones.last_station_change_date ? new Date(clones.last_station_change_date).getTime() + 365 * 86400e3 : 0;
  const jc = clones.jump_clones || [];
  const implantList = (list) => list?.length ? `<div class="clone-implants">${list.map((t) => typeCell(types, t)).join('')}</div>` : '<span class="text-muted">没有植入体</span>';
  box.innerHTML =
    '<div class="valuation-grid">' +
      ctx.valuationCard('跳跃克隆', jc.length + ' 个', '不含当前克隆') +
      ctx.valuationCard('下次可跳克隆', next > Date.now() ? left(next - Date.now()) + '后' : '现在可跳', `冷却 ${24 - sync} 小时`, next > Date.now() ? 'is-sell' : 'is-buy') +
      ctx.valuationCard('医疗克隆', esc(ctx.locationName(clones.home_location?.location_id)), stationChange > Date.now() ? `${left(stationChange - Date.now())}后可更换` : '可更换') +
    '</div>' +
    '<section class="info-section"><h4 class="info-section-title">当前植入体</h4>' + (implants ? implantList(implants) : '<p class="text-muted">无植入体权限</p>') + '</section>' +
    '<section class="info-section"><h4 class="info-section-title">跳跃克隆</h4>' +
      (jc.length ? jc.map((c) => `<div class="clone-card"><div class="clone-head"><b>${esc(c.name || '跳跃克隆')}</b><span>${esc(ctx.locationName(c.location_id))}</span>
        <button class="link-btn" data-game-dest="${c.location_id}" title="在游戏里设为目的地">设目的地</button></div>${implantList(c.implants)}</div>`).join('')
        : '<p class="text-muted">没有跳跃克隆</p>') +
    '</section>';
}

// ---------- 挖矿 ----------
const renderMining = (box) => perChar('mining', box, miningOne);
async function miningOne(box, id, alive) {
  if (!can(id, 'esi-industry.read_character_mining.v1')) { box.innerHTML = '<p class="text-muted" title="esi-industry.read_character_mining.v1">无挖矿记录权限，需重新绑定 ESI</p>'; return; }
  box.innerHTML = loading('读取中…');
  let data;
  try {
    data = await cached('mining', async (cid) => {
      const rows = await getPaged(cid, '/characters/' + cid + '/mining/', 10);
      const types = await ctx.resolveTypeNames(rows.map((r) => r.type_id));
      return { rows, types };
    }, id);
  } catch (error) { if (alive()) box.innerHTML = fail('挖矿记录', error); return; }
  if (!alive()) return;
  const { rows, types } = data;
  if (!rows.length) { box.innerHTML = '<p class="text-muted">最近 30 天没有挖矿记录</p>'; return; }
  const val = await ctx.valuation.items(rows, (d, t) => { if (t > d && alive()) box.innerHTML = loading(`读取${val0().hub.name}行情 ${d}/${t}…`); });
  if (!alive()) return;
  const sellOf = (r) => (val.price(r.type_id).sell || 0) * r.quantity;
  const buyOf = (r) => (val.price(r.type_id).buy || 0) * r.quantity;
  const byType = new Map(), byDay = new Map();
  let units = 0;
  for (const r of rows) {
    const sv = sellOf(r), bv = buyOf(r);
    units += r.quantity;
    const t = byType.get(r.type_id) || { id: r.type_id, qty: 0, sell: 0, buy: 0 };
    t.qty += r.quantity; t.sell += sv; t.buy += bv; byType.set(r.type_id, t);
    const d = byDay.get(r.date) || { date: r.date, sell: 0, buy: 0, qty: 0, systems: new Set() };
    d.sell += sv; d.buy += bv; d.qty += r.quantity; d.systems.add(r.solar_system_id); byDay.set(r.date, d);
  }
  const systems = new Set(rows.map((r) => r.solar_system_id));
  const typeRows = [...byType.values()].sort((a, b) => b.sell - a.sell).map((t) => tr([
    typeCell(types, t.id), ctx.formatNumber(t.qty), ctx.formatISK(t.sell), ctx.formatISK(t.buy), val.sell ? (t.sell / val.sell * 100).toFixed(1) + '%' : '—']));
  const dayRows = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)).map((d) => tr([
    esc(d.date), esc([...d.systems].map((s) => ctx.officialName(s) || s).join('、')), ctx.formatNumber(d.qty), ctx.formatISK(d.sell), ctx.formatISK(d.buy)]));
  box.innerHTML =
    `<div class="valuation-toolbar">${ctx.valuation.select('data-val-src="mining"', val.region)}</div>` +
    '<div class="valuation-grid section-gap">' +
      ctx.valuation.cards(val, '估算收益') +
      ctx.valuationCard('挖矿总量', ctx.formatNumber(units) + ' 单位', byType.size + ' 种矿 · ' + byDay.size + ' 天 · ' + systems.size + ' 个星系') +
      ctx.valuationCard('日均', ctx.formatISK(val.sell / byDay.size) + ' ISK', '按最低卖价') +
    '</div>' +
    '<section class="info-section"><h4 class="info-section-title">按矿种</h4>' + table(['矿种', '数量', '最低卖价估值', '最高收价估值', '占比'], typeRows) + '</section>' +
    '<section class="info-section"><h4 class="info-section-title">按日期</h4>' + table(['日期', '星系', '数量', '最低卖价估值', '最高收价估值'], dayRows) + '</section>' +
    `<p class="text-muted valuation-note" title="按${esc(val.region.hub.name)}矿石原价（未精炼）；ESI 保留最近 30 天">最近 30 天</p>`;
}

// ---------- 研究代理人 ----------
let npcPromise = null;
function npcStations() {
  if (!npcPromise) npcPromise = fetch('./npc-data.json?v=2').then((r) => r.json()).then((d) => new Map(d.npcs.map((n) => [n[0], { station: n[4], system: n[5], corp: n[3] }]))).catch(() => { npcPromise = null; return new Map(); });
  return npcPromise;
}
const renderResearch = (box) => perChar('research', box, researchOne);
async function researchOne(box, id, alive) {
  if (!canGroup(id, 'research')) { box.innerHTML = id === me() ? ctx.scopeNeededHtml('research', '查看研究代理人') : '<p class="text-muted">没有「研究代理人」权限</p>'; return; }
  box.innerHTML = loading('读取中…');
  let data;
  try {
    data = await cached('research', async (cid) => {
      const [list, npcs] = await Promise.all([get(cid, '/characters/' + cid + '/agents_research/'), npcStations()]);
      const types = await ctx.resolveTypeNames(list.map((r) => r.skill_type_id));
      return { list, npcs, types };
    }, id);
  } catch (error) { if (alive()) box.innerHTML = fail('研究代理人', error); return; }
  if (!alive()) return;
  const { list, npcs, types } = data;
  if (!list.length) { box.innerHTML = '<p class="text-muted">没有进行中的研究</p>'; return; }
  const now = Date.now();
  const rows = list.map((r) => {
    const days = (now - new Date(r.started_at).getTime()) / 86400e3;
    return { ...r, rp: r.remainder_points + r.points_per_day * days, days, npc: npcs.get(r.agent_id) };
  }).sort((a, b) => b.rp - a.rp);
  const totalDay = rows.reduce((t, r) => t + r.points_per_day, 0);
  box.innerHTML =
    '<div class="valuation-grid">' +
      ctx.valuationCard('研究代理人', rows.length + ' 名', '') +
      ctx.valuationCard('累计研究点', ctx.formatNumber(Math.floor(rows.reduce((t, r) => t + r.rp, 0))) + ' RP', '', 'is-buy') +
      ctx.valuationCard('每日合计', ctx.formatNumber(Math.round(totalDay * 100) / 100) + ' RP', '') +
    '</div>' +
    table(['代理人', '地点', '研究领域', '每日', '当前研究点', '开始于'], rows.map((r) => tr([
      `<b>${esc(ctx.officialName(r.agent_id) || '代理人 ' + r.agent_id)}</b>${r.npc ? `<span class="cell-sub">${esc(ctx.officialName(r.npc.corp) || '')}</span>` : ''}`,
      r.npc ? `<button class="link-btn trade-loc" data-map-sys="${r.npc.system}" title="在星图中查看">${esc(r.npc.station ? ctx.locationName(r.npc.station) : ctx.officialName(r.npc.system) || '')}</button>` : '—',
      esc(types.get(r.skill_type_id) || 'Type ' + r.skill_type_id),
      ctx.formatNumber(Math.round(r.points_per_day * 100) / 100),
      `<strong class="up">${ctx.formatNumber(Math.floor(r.rp))}</strong>`,
      esc(fmtDate(r.started_at, false)) + `<span class="cell-sub">${Math.floor(r.days)} 天</span>`])), 'trade-table') +
    '';
}

// ---------- 舰队 ----------
async function renderFleet(box) {
  const id = me();
  if (!ctx.hasScopeGroup('fleet')) { box.innerHTML = ctx.scopeNeededHtml('fleet', '查看舰队'); return; }
  box.innerHTML = loading('读取中…');
  let data;
  try {
    data = await cached('fleet', async (cid) => {
      let fleet;
      try { fleet = await ctx.esiAuthFetch('/characters/' + cid + '/fleet/'); } catch (error) {
        if (error.status === 404) return { none: true };
        throw error;
      }
      let members = null, membersError = '';
      try { members = await ctx.esiAuthFetch('/fleets/' + fleet.fleet_id + '/members/?language=zh'); } catch (error) {
        membersError = error.status === 403 || error.status === 404 ? '仅舰队 Boss 可读取成员列表' : error.message;
      }
      const wings = members ? await ctx.esiAuthFetch('/fleets/' + fleet.fleet_id + '/wings/?language=zh').catch(() => []) : [];
      const types = members ? await ctx.resolveTypeNames(members.map((m) => m.ship_type_id)) : new Map();
      const names = members ? (await ctx.resolveNames(members.map((m) => m.character_id)).catch(() => ({ names: new Map() }))).names : new Map();
      if (members) await ST.lookupIds(members.map((m) => m.character_id));   // 成员声望（军团 / 联盟）
      return { fleet, members, membersError, wings, types, names };
    });
  } catch (error) { if (still('fleet', id)) box.innerHTML = fail('舰队', error); return; }
  if (!still('fleet', id)) return;
  if (data.none) { box.innerHTML = '<p class="text-muted">当前不在舰队中</p>'; return; }
  const { fleet, members, membersError, wings, types, names } = data;
  const ROLE = { fleet_commander: '舰队指挥', wing_commander: '联队指挥', squad_commander: '中队指挥', squad_member: '队员' };
  const head = ctx.valuationCard('我的职位', ROLE[fleet.role] || fleet.role, '舰队 ID ' + fleet.fleet_id);
  if (!members) { box.innerHTML = '<div class="valuation-grid">' + head + '</div><p class="text-muted">' + esc(membersError) + '</p>'; return; }
  const count = (key) => { const m = new Map(); for (const x of members) m.set(x[key], (m.get(x[key]) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const ships = count('ship_type_id'), systems = count('solar_system_id');
  const wingName = new Map(); const squadName = new Map();
  for (const w of wings || []) { wingName.set(w.id, w.name); for (const sq of w.squads || []) squadName.set(sq.id, sq.name); }
  const views = [['ships', '舰船分布', ships.length], ['systems', '位置分布', systems.length], ['members', '成员', members.length]];
  const body = S.fleetView === 'systems'
    ? table(['星系', '人数'], systems.map(([sys, n]) => tr([`<button class="link-btn" data-map-sys="${sys}">${esc(ctx.officialName(sys) || sys)}</button>`, n])))
    : S.fleetView === 'members'
      ? table(['成员', '舰船', '位置', '职位', '联队 / 中队'], members.map((m) => tr([
        ST.badge(ST.entById(m.character_id)) + esc(names.get(m.character_id) || m.character_id), typeCell(types, m.ship_type_id), esc(ctx.officialName(m.solar_system_id) || m.solar_system_id) + (m.station_id ? '<span class="cell-sub">停靠中</span>' : ''),
        esc(m.role_name || ROLE[m.role] || m.role), esc([wingName.get(m.wing_id), squadName.get(m.squad_id)].filter(Boolean).join(' / ') || '—')])))
      : table(['舰船', '数量', '占比'], ships.map(([t, n]) => tr([typeCell(types, t), n, (n / members.length * 100).toFixed(0) + '%'])));
  box.innerHTML =
    '<div class="valuation-grid">' + head +
      ctx.valuationCard('成员', members.length + ' 人', ships.length + ' 种舰船') +
      ctx.valuationCard('所在星系', systems.length + ' 个', systems[0] ? '最多：' + esc(ctx.officialName(systems[0][0]) || systems[0][0]) + ' ' + systems[0][1] + ' 人' : '') +
    '</div>' +
    `<div class="valuation-toolbar section-gap"><div class="segmented" role="group">${views.map(([k, l, n]) => `<button data-more-view="fleet:${k}" class="${S.fleetView === k ? 'active' : ''}">${l} <span class="seg-count">${n}</span></button>`).join('')}</div>
      <span class="toolbar-spacer"></span><button class="btn btn-ghost" data-more-reload="fleet">刷新</button></div>` + body;
}

// ---------- 军团 ----------
const ACTIVITY = { 1: '制造', 3: '时间效率研究', 4: '材料效率研究', 5: '拷贝', 7: '逆向工程', 8: '发明', 9: '反应', 11: '反应' };
const JOB_STATUS = { active: '进行中', paused: '暂停', ready: '可交付', delivered: '已交付', cancelled: '已取消', reverted: '已撤销' };
const STRUCT_STATE = {
  shield_vulnerable: '正常（护盾可攻击）', armor_reinforce: '装甲增强中', hull_reinforce: '结构增强中', armor_vulnerable: '装甲可攻击', hull_vulnerable: '结构可攻击',
  anchoring: '锚定中', unanchored: '未锚定', onlining_vulnerable: '上线中', online_deprecated: '在线', fitting_invulnerable: '装配中', deploy_vulnerable: '部署中', anchor_vulnerable: '锚定中', unknown: '未知'
};
const ROLE_ZH = { Director: '总监', Accountant: '会计', Junior_Accountant: '初级会计', Trader: '交易员', Factory_Manager: '工厂管理员', Station_Manager: '空间站管理员', Personnel_Manager: '人事经理', Security_Officer: '安全官', Config_Equipment: '设备配置', Brand_Manager: '品牌经理' };

async function corpBase(cid) {
  const [roles, pub] = await Promise.all([
    ctx.esiAuthFetch('/characters/' + cid + '/roles/').catch(() => ({ roles: [] })),
    ctx.fetchESI('/characters/' + cid + '/')
  ]);
  return { roles: roles.roles || [], corp: pub.corporation_id };
}

const CORP_LOAD = {
  wallets: async (corp) => {
    const [wallets, divisions] = await Promise.all([ctx.esiAuthFetch(`/corporations/${corp}/wallets/`), ctx.esiAuthFetch(`/corporations/${corp}/divisions/`).catch(() => null)]);
    return { wallets, names: new Map((divisions?.wallet || []).map((d) => [d.division, d.name])) };
  },
  orders: async (corp) => {
    const orders = await ctx.esiAuthFetchPaged(`/corporations/${corp}/orders/`, 10);
    const types = await ctx.resolveTypeNames(orders.map((o) => o.type_id));
    await ctx.resolveStructureNames(orders.map((o) => o.location_id)).catch(() => {});
    return { orders, types };
  },
  jobs: async (corp) => {
    const jobs = await ctx.esiAuthFetchPaged(`/corporations/${corp}/industry/jobs/?include_completed=true`, 5);
    const types = await ctx.resolveTypeNames(jobs.flatMap((j) => [j.blueprint_type_id, j.product_type_id]));
    const names = (await ctx.resolveNames(jobs.map((j) => j.installer_id)).catch(() => ({ names: new Map() }))).names;
    await ctx.resolveStructureNames(jobs.map((j) => j.facility_id)).catch(() => {});
    return { jobs, types, names };
  },
  structures: async (corp) => {
    const [list] = await Promise.all([ctx.esiAuthFetchPaged(`/corporations/${corp}/structures/?language=zh`, 5), IS.loadRigs().catch(() => {})]);
    const types = await ctx.resolveTypeNames(list.map((s) => s.type_id));
    const secs = new Map(await Promise.all([...new Set(list.map((s) => s.system_id))].map(async (id) => [id, (await ctx.fetchESI(`/universe/systems/${id}/`).catch(() => null))?.security_status ?? null])));
    await ctx.resolveStructureNames(list.map((s) => s.structure_id)).catch(() => {});
    const d = { corp, list, types, secs, fits: null, fitErr: '' };
    // 装配读军团资产（需要总监、可能很多页），不挡表格：读完再画一次
    d.fitsP = !ctx.hasScope('esi-assets.read_corporation_assets.v1') ? Promise.resolve().then(() => { d.fitErr = 'scope'; })
      : IS.corpFittings(ctx, corp, true).then(async (fits) => {
        const names = await ctx.resolveTypeNames(list.flatMap((s) => (fits.get(s.structure_id) || []).map((x) => x.t)));
        for (const [k, v] of names) d.types.set(k, v);
        d.fits = fits;
      }, (e) => { d.fitErr = e.status === 403 || /403/.test(e.message) ? 'role' : e.message || 'error'; });
    return d;
  },
  moons: async (corp) => {
    const list = await ctx.esiAuthFetch(`/corporation/${corp}/mining/extractions/`);
    const moonNames = new Map(await Promise.all([...new Set(list.map((m) => m.moon_id))].map(async (id) => [id, (await ctx.fetchESI(`/universe/moons/${id}/?language=zh`).catch(() => null))?.name || '卫星 ' + id])));
    await ctx.resolveStructureNames(list.map((m) => m.structure_id)).catch(() => {});
    return { list, moonNames };
  },
  assets: async (corp) => {
    const [assets, avg] = await Promise.all([ctx.esiAuthFetchPaged(`/corporations/${corp}/assets/`, 20), ctx.getMarketPriceMap()]);
    const byType = new Map();
    for (const a of assets) {
      if (a.is_blueprint_copy) continue;
      const t = byType.get(a.type_id) || { type_id: a.type_id, quantity: 0 };
      t.quantity += a.quantity || 1;
      byType.set(a.type_id, t);
    }
    // 按全服均价挑出最值钱的 1500 种去查交易中心行情（没有均价的基本不可交易）
    const list = [...byType.values()].filter((t) => !avg.size || avg.has(t.type_id))
      .sort((a, b) => (avg.get(b.type_id) || 0) * b.quantity - (avg.get(a.type_id) || 0) * a.quantity).slice(0, 1500);
    return { count: assets.length, kinds: byType.size, list };
  }
};

function corpBody(view, d) {
  const { formatISK, formatPrice, formatNumber, locationName } = ctx;
  if (view === 'wallets') {
    const total = d.wallets.reduce((t, w) => t + w.balance, 0);
    return '<div class="valuation-grid">' + ctx.valuationCard('军团钱包合计', formatISK(total) + ' ISK', d.wallets.length + ' 个部门', 'is-total') + '</div>' +
      table(['部门', '余额'], d.wallets.map((w) => tr([esc(d.names.get(w.division) || (w.division === 1 ? '总钱包' : '部门 ' + w.division)), formatPrice(w.balance) + ' ISK'])));
  }
  if (view === 'orders') {
    if (!d.orders.length) return '<p class="text-muted">军团没有有效订单</p>';
    const sum = (buy) => d.orders.filter((o) => !!o.is_buy_order === buy).reduce((t, o) => t + o.price * o.volume_remain, 0);
    return '<div class="valuation-grid">' + ctx.valuationCard('卖单挂单额', formatISK(sum(false)) + ' ISK', '', 'is-sell') + ctx.valuationCard('收单挂单额', formatISK(sum(true)) + ' ISK', '', 'is-buy') + '</div>' +
      table(['物品', '方向', '单价', '剩余 / 总量', '地点', '钱包部门', '挂单时间'], d.orders.map((o) => tr([
        typeCell(d.types, o.type_id), o.is_buy_order ? '<span class="pill buy">收购</span>' : '<span class="pill sell">出售</span>', formatPrice(o.price),
        formatNumber(o.volume_remain) + ' / ' + formatNumber(o.volume_total), `<span class="trade-loc">${esc(locationName(o.location_id))}</span>`, o.wallet_division, esc(fmtDate(o.issued))])), 'trade-table');
  }
  if (view === 'jobs') {
    if (!d.jobs.length) return '<p class="text-muted">没有工业任务</p>';
    const active = d.jobs.filter((j) => j.status === 'active');
    return '<div class="valuation-grid">' + ctx.valuationCard('进行中', active.length + ' 项', '') + ctx.valuationCard('可交付', d.jobs.filter((j) => j.status === 'ready' || (j.status === 'active' && new Date(j.end_date) < new Date())).length + ' 项', '', 'is-buy') + '</div>' +
      table(['蓝图 / 产物', '活动', '流程', '状态', '完成时间', '安装者', '设施'], d.jobs.sort((a, b) => new Date(a.end_date) - new Date(b.end_date)).map((j) => {
        const done = j.status === 'active' && new Date(j.end_date) < new Date();
        return tr([typeCell(d.types, j.product_type_id || j.blueprint_type_id), esc(ACTIVITY[j.activity_id] || j.activity_id), j.runs,
          done ? '<span class="up">可交付</span>' : esc(JOB_STATUS[j.status] || j.status),
          esc(fmtDate(j.end_date)) + (j.status === 'active' && !done ? `<span class="cell-sub">还剩 ${left(new Date(j.end_date) - Date.now())}</span>` : ''),
          esc(d.names.get(j.installer_id) || j.installer_id), `<span class="trade-loc">${esc(locationName(j.facility_id))}</span>`]);
      }), 'trade-table');
  }
  if (view === 'structures') {
    if (!d.list.length) return '<p class="text-muted">军团没有建筑</p>';
    const soon = d.list.filter((s) => s.fuel_expires && new Date(s.fuel_expires) - Date.now() < 7 * 86400e3);
    const note = d.fitErr === 'scope' ? '授权里没有军团资产权限，读不到装配，只列出服务与船体加成（个人中心重新绑定 ESI 时勾选「军团管理」）'
      : d.fitErr === 'role' ? '读不到军团资产（需要总监职位），只列出服务与船体加成'
      : d.fitErr ? '军团资产读取失败：' + d.fitErr : '';
    return '<div class="valuation-grid">' + ctx.valuationCard('建筑', d.list.length + ' 座', '') +
      ctx.valuationCard('燃料不足 7 天', soon.length + ' 座', '', soon.length ? 'is-sell' : 'is-buy') + '</div>' +
      (FP.isOpen(d.corp) ? FP.html(d, d.corp)
        : `<div class="valuation-toolbar section-gap fuel-bar"><button class="btn" data-fuel-toggle="${d.corp}" aria-expanded="false">统一添油</button><span class="text-muted">算这次带的燃料块每座建筑加多少，让下次一起到期</span></div>`) +
      `<p class="text-muted valuation-note">点开一行查看装配与加成${note ? ' · ' + esc(note) : ''}</p>` +
      table(['建筑', '类型', '星系', '燃料', '状态', '服务'], [...d.list].sort((a, b) => (a.fuel_expires ? new Date(a.fuel_expires) : Infinity) - (b.fuel_expires ? new Date(b.fuel_expires) : Infinity)).map((s) => {
        const ms = s.fuel_expires ? new Date(s.fuel_expires) - Date.now() : null;
        const fuel = ms == null ? '<span class="muted-cell">无燃料 / 低功率</span>' : `<span class="${ms < 3 * 86400e3 ? 'down' : ms < 7 * 86400e3 ? 'warn-text' : 'up'}">${left(ms)}</span><span class="cell-sub">${esc(fmtDate(s.fuel_expires))}</span>`;
        const services = (s.services || []).map((x) => `<span class="pill${x.state === 'online' ? ' buy' : ''}">${esc(x.name)}</span>`).join(' ');
        const sec = d.secs?.get(s.system_id);
        const open = SF_OPEN.has(s.structure_id);
        return `<tr class="sf-tr${open ? ' open' : ''}" data-sf-open="${s.structure_id}" aria-expanded="${open}">` + [
          `<span class="sf-name">${CHEVRON}<b>${esc(s.name || locationName(s.structure_id))}</b></span>`, esc(d.types.get(s.type_id) || s.type_id),
          `<button class="link-btn" data-map-sys="${s.system_id}">${esc(ctx.officialName(s.system_id) || s.system_id)}</button>${sec != null ? ` <span class="text-muted">${fmtSec(sec)}</span>` : ''}`,
          fuel, esc(STRUCT_STATE[s.state] || s.state) + (s.state_timer_end ? `<span class="cell-sub">计时 ${esc(fmtDate(s.state_timer_end))}</span>` : ''), services || '—'
        ].map((c) => `<td>${c}</td>`).join('') + `</tr><tr class="sf-detail-row"${open ? '' : ' hidden'}><td colspan="6">${fitDetail(s, d)}</td></tr>`;
      }), 'trade-table sf-table');
  }
  if (view === 'moons') {
    if (!d.list.length) return '<p class="text-muted">没有进行中的月矿提取</p>';
    return table(['卫星', '精炼厂', '开始', '矿块到达', '自然崩解'], [...d.list].sort((a, b) => new Date(a.chunk_arrival_time) - new Date(b.chunk_arrival_time)).map((m) => {
      const ms = new Date(m.chunk_arrival_time) - Date.now();
      return tr([esc(d.moonNames.get(m.moon_id)), `<span class="trade-loc">${esc(locationName(m.structure_id))}</span>`, esc(fmtDate(m.extraction_start_time)),
        esc(fmtDate(m.chunk_arrival_time)) + `<span class="cell-sub">${ms > 0 ? '还剩 ' + left(ms) : '已到达'}</span>`, esc(fmtDate(m.natural_decay_time))]);
    }), 'trade-table');
  }
  return '';
}

// ---------- 建筑装配与加成 ----------
const CHEVRON = '<svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
const SLOT_GROUPS = [['HiSlot', '高槽'], ['MedSlot', '中槽'], ['LoSlot', '低槽'], ['RigSlot', '改装件'], ['ServiceSlot', '服务槽'], ['QuantumCoreRoom', '量子核心'], ['FighterTube', '舰载机发射管']];
const ACT_ZH = { m: '制造', r: '反应', i: '发明', c: '拷贝', me: '材料研究', te: '时间研究' };
const KIND_ZH = { me: '材料', te: '时间', cost: '费用' };
const SEC_ZH = ['高安', '低安', '00 / 虫洞'];
const fmtSec = (v) => (v == null ? '' : (v > 0 && v < 0.05 ? 0.1 : Math.round(v * 10) / 10).toFixed(1));
const yPct = (v) => (v * 100).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '%';
const minus = (v) => `−${String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;
// 工业加成文字：[[活动, 种类, 减免 %]] → 「制造 材料 −2% · 时间 −20%」，活动相同的合在一起，数值相同的活动也合在一起
function indText(list) {
  const byAct = new Map();
  for (const [a, k, v] of list) { if (!v) continue; if (!byAct.has(a)) byAct.set(a, []); byAct.get(a).push([k, v]); }
  const byText = new Map();
  for (const [a, kinds] of byAct) {
    const t = kinds.sort((x, y) => Object.keys(KIND_ZH).indexOf(x[0]) - Object.keys(KIND_ZH).indexOf(y[0])).map(([k, v]) => `<span>${KIND_ZH[k]}</span> ${minus(v)}`).join(' · ');
    if (!byText.has(t)) byText.set(t, []);
    byText.get(t).push(ACT_ZH[a] || a);
  }
  // 每个词单独一个元素，英文界面逐个翻译
  return [...byText].map(([t, acts]) => `<span class="sf-bonus-item"><b>${acts.map((a) => `<span>${esc(a)}</span>`).join(' / ')}</b> ${t}</span>`).join('');
}
const RP_ZH = { o: '矿石', m: '卫星矿', i: '冰矿' };
function fitDetail(s, d) {
  const sec = d.secs.get(s.system_id);
  const hull = IS.hullOf(s.type_id);
  const items = d.fits?.get(s.structure_id) || [];
  const icon = (t) => `<img src="${ctx.gameImage('types/' + t + '/icon', 32)}" alt="" width="20" height="20" loading="lazy">`;
  const name = (t) => esc(d.types.get(Number(t)) || 'Type ' + t);
  // 槽位
  const rows = [];
  const rigIds = [];
  for (const [flag, label] of SLOT_GROUPS) {
    const list = items.filter((x) => x.f.replace(/\d+$/, '') === flag).sort((a, b) => a.f.localeCompare(b.f) || b.q - a.q);
    if (!list.length) continue;
    if (flag === 'RigSlot') {
      rows.push(`<div class="sf-row"><span>${label}</span><div class="sf-rigs">${list.map((x) => {
        rigIds.push(x.t);
        const e = IS.rigEffects(x.t, sec);
        const txt = e ? [indText(e.ind), e.rp ? `<span class="sf-bonus-item"><b>化矿</b> ${e.rp[1].split('').map((c) => `<span>${RP_ZH[c]}</span>`).join(' / ')} ${yPct(e.rp[0])}</span>` : ''].join('') : '';
        return `<div class="sf-rig"><span class="trade-item">${icon(x.t)}${name(x.t)}</span>${txt ? `<div class="sf-bonus">${txt}${e && e.k !== 1 ? `<small class="text-muted" title="已乘安全等级倍数"><span>${esc(SEC_ZH[IS.secCol(sec)])}</span> ×${e.k}</small>` : ''}</div>` : ''}</div>`;
      }).join('')}</div></div>`);
      continue;
    }
    rows.push(`<div class="sf-row"><span>${label}</span><div class="sf-items">${list.map((x) => `<span class="trade-item">${icon(x.t)}${name(x.t)}${x.q > 1 ? ` <small class="text-muted">× ${ctx.formatNumber(x.q)}</small>` : ''}</span>`).join('')}</div></div>`);
  }
  if (!d.fits) rows.push(`<p class="text-muted">${d.fitErr ? '读不到装配' : '读取装配…'}</p>`);
  else if (!items.length) rows.push('<p class="text-muted">资产里没有这座建筑的装配</p>');
  // 加成：船体 + 化矿（装了提炼设施，或读不到装配时船体有化矿加成 / 服务里有精炼）
  const bonus = [];
  const hb = Object.entries(hull?.b || {}).flatMap(([a, row]) => row.map((v, i) => [a, ['me', 'te', 'cost'][i], v]));
  if (hb.length) bonus.push(`<div class="sf-row"><span>船体</span><div class="sf-bonus">${indText(hb)}</div></div>`);
  const canRp = d.fits ? items.some((x) => IS.isRpService(x.t)) : (s.services || []).some((x) => /reprocess|精炼|提炼/i.test(x.name || ''));
  if (canRp && IS.rigData()) {
    const b = IS.reprocBase(s.type_id, rigIds, sec);
    bonus.push(`<div class="sf-row"><span>化矿</span><div class="sf-bonus"><span class="sf-bonus-item">${['矿石', '卫星矿', '冰矿'].map((l, i) => `<span>${l}</span> <b class="up">${yPct(b.ore[i])}</b>`).join(' · ')}</span><small class="text-muted">${['不含技能', hull?.rp ? `含船体 +${hull.rp}%` : '', d.fits ? '' : '改装件未计入'].filter(Boolean).join(' · ')}</small></div></div>`);
  }
  if (!bonus.length && !rigIds.some((t) => { const e = IS.rigEffects(t, sec); return e && (e.ind.length || e.rp); })) bonus.push('<p class="text-muted">没有工业 / 化矿加成</p>');
  return `<div class="sf-detail"><div><div class="sf-sub">装配</div>${rows.join('')}</div>${bonus.length ? `<div><div class="sf-sub">建筑加成</div>${bonus.join('')}</div>` : ''}</div>`;
}

// 军团资产：按所选交易中心估值
async function corpAssets(d, body, alive) {
  const { formatISK, formatNumber } = ctx;
  const val = await ctx.valuation.items(d.list, (n, t) => { if (t > n && alive()) body.innerHTML = loading(`读取${val0().hub.name}行情 ${n}/${t}…`); });
  if (!alive()) return;
  const top = d.list.map((t) => ({ ...t, sell: (val.price(t.type_id).sell || 0) * t.quantity, buy: (val.price(t.type_id).buy || 0) * t.quantity }))
    .sort((a, b) => b.sell - a.sell).slice(0, 200);
  const types = await ctx.resolveTypeNames(top.map((t) => t.type_id));
  if (!alive()) return;
  body.innerHTML = `<div class="valuation-toolbar">${ctx.valuation.select('data-val-src="corp"', val.region)}</div>` +
    '<div class="valuation-grid section-gap">' + ctx.valuation.cards(val, '资产估值', true) + ctx.valuationCard('资产条目', formatNumber(d.count) + ' 项', d.kinds + ' 种物品') + '</div>' +
    table(['物品', '数量', '最低卖价估值', '最高收价估值'], top.map((t) => tr([typeCell(types, t.type_id), formatNumber(t.quantity), formatISK(t.sell), formatISK(t.buy)]))) +
    (d.list.length > 200 ? `<p class="text-muted valuation-note">仅显示估值前 200 种</p>` : '');
}

let corpPaint = null;   // 军团当前视图的重画函数
async function renderCorp(box) {
  const id = me();
  if (!ctx.hasScopeGroup('corp')) { box.innerHTML = ctx.scopeNeededHtml('corp', '查看军团数据'); return; }
  box.innerHTML = loading('读取中…');
  let base;
  try { base = await cached('corp:base', corpBase); } catch (error) { if (still('corp', id)) box.innerHTML = fail('军团职位', error); return; }
  if (!still('corp', id)) return;
  if (base.corp < 2000000) { box.innerHTML = '<p class="text-muted">当前在 NPC 军团</p>'; return; }
  const roles = base.roles.map((r) => ROLE_ZH[r] || r);
  const view = S.corpView;
  box.innerHTML =
    `<p class="corp-roles">军团职位：${roles.length ? roles.map((r) => `<span class="pill">${esc(r)}</span>`).join(' ') : '<span class="text-muted">无</span>'}</p>` +
    `<div class="valuation-toolbar section-gap"><div class="segmented" role="group">${CORP_VIEWS.map(([k, l]) => `<button data-more-view="corp:${k}" class="${view === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="toolbar-spacer"></span><button class="btn btn-ghost" data-more-reload="corp:${view}">刷新</button></div>` +
    `<div data-corp-body>${loading('读取中…')}</div>`;
  const body = box.querySelector('[data-corp-body]');
  try {
    const d = await cached('corp:' + view, () => CORP_LOAD[view](base.corp));
    const alive = () => still('corp', id) && S.corpView === view && body.isConnected;
    // 统一添油改了设置也用它重画（保住正在打字的输入框）
    const paint = () => { if (!alive()) return; FP.keepFocus(body, () => { body.innerHTML = corpBody(view, d); }); FP.update(body); };
    corpPaint = paint;
    if (alive()) { if (view === 'assets') await corpAssets(d, body, alive); else paint(); }
    if (d.fitsP && !d.fits && !d.fitErr) { await d.fitsP; paint(); }
  } catch (error) {
    if (!still('corp', id) || S.corpView !== view) return;
    const need = CORP_VIEWS.find((v) => v[0] === view)[2];
    body.innerHTML = error.status === 403 ? `<p class="text-muted">需要军团职位「${esc(need)}」</p>` : fail('军团数据', error);
  }
}

// ---------- 邮件 ----------
// /characters/{id}/mail/labels/ + /mail/?labels=&last_mail_id=（每次 50 封）+ /mail/{mail_id}/（「游戏邮件」权限 esi-mail.read_mail.v1）
// 邮件正文是游戏里的富文本（<font>、<a href="showinfo:…">、<br>），这里只保留文字与换行
const MAIL_LABEL_ZH = { 1: '收件箱', 2: '已发送', 4: '军团', 8: '联盟' };
const M = { label: 1, list: [], more: true, open: 0, bodies: new Map(), names: new Map(), labels: null, loading: false };
window.addEventListener('eve-account-change', () => { M.list = []; M.more = true; M.open = 0; M.bodies.clear(); M.labels = null; });
function mailText(html) {
  // DOMParser 解析出的文档不执行脚本、不加载图片（不能用页面里的元素 innerHTML，<img onerror> 会执行）
  const doc = new DOMParser().parseFromString(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
async function loadMail(id, more) {
  if (!M.labels) M.labels = await ctx.esiAuthFetch(`/characters/${id}/mail/labels/`).catch(() => ({ labels: [] }));
  const last = more && M.list.length ? '&last_mail_id=' + M.list[M.list.length - 1].mail_id : '';
  const page = await ctx.esiAuthFetch(`/characters/${id}/mail/?labels=${M.label}${last}`);
  M.list = more ? M.list.concat(page) : page;
  M.more = page.length >= 50;
  const ids = [...new Set(page.flatMap((m) => [m.from, ...(m.recipients || []).map((r) => r.recipient_id)]).filter((x) => x && !M.names.has(x)))];
  if (ids.length) { const { names } = await ctx.resolveNames(ids); for (const [k, v] of names) M.names.set(k, v); }
}
async function renderMail(box, more = false) {
  const id = me();
  if (!ctx.hasScopeGroup('mail')) { box.innerHTML = ctx.scopeNeededHtml('mail', '查看邮件'); return; }
  if (!M.list.length || more) {
    if (!more) box.innerHTML = loading('读取中…');
    M.loading = true;
    try { await loadMail(id, more); } catch (error) { M.loading = false; if (still('mail', id)) box.innerHTML = fail('邮件', error); return; }
    M.loading = false;
  }
  if (!still('mail', id)) return;
  const labels = [...(M.labels?.labels || [])].sort((a, b) => a.label_id - b.label_id);
  const name = (x) => esc(M.names.get(x) || ctx.officialName(x) || 'ID ' + x);
  const rows = M.list.map((m) => {
    const body = M.bodies.get(m.mail_id);
    const open = M.open === m.mail_id;
    return `<tr class="mail-row${m.is_read ? '' : ' unread'}${open ? ' open' : ''}" data-mail="${m.mail_id}">
      <td>${M.label === 2 ? (m.recipients || []).slice(0, 3).map((r) => name(r.recipient_id)).join('、') : name(m.from)}</td>
      <td class="mail-subject">${esc(m.subject || '（无主题）')}</td><td class="num">${fmtDate(m.timestamp)}</td></tr>
      ${open ? `<tr class="mail-body-row"><td colspan="3"><div class="mail-body">${body == null ? loading('读取正文…') : esc(body).replace(/\n/g, '<br>')}</div></td></tr>` : ''}`;
  }).join('');
  box.innerHTML = `<div class="valuation-toolbar"><div class="segmented" role="group">${labels.map((l) => `<button data-mail-label="${l.label_id}" class="${M.label === l.label_id ? 'active' : ''}">${esc(MAIL_LABEL_ZH[l.label_id] || l.name)}${l.unread_count ? ` <b class="mail-unread">${l.unread_count}</b>` : ''}</button>`).join('')}</div>
      <span class="toolbar-spacer"></span>${M.labels?.total_unread_count ? `<span class="text-muted">未读 ${M.labels.total_unread_count} 封</span>` : ''}<button class="btn btn-ghost" data-mail-reload>刷新</button></div>
    ${M.list.length ? `<div class="table-scroll"><table class="pc-mini-table mail-table"><thead><tr><th>${M.label === 2 ? '收件人' : '发件人'}</th><th>主题</th><th class="num">时间</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${M.more ? '<div class="au-more"><button class="btn btn-ghost" data-mail-more>再读 50 封</button></div>' : ''}` : '<p class="text-muted">这个文件夹里没有邮件</p>'}
    <p class="text-muted valuation-note">不会标记为已读</p>`;
}
async function openMail(box, mailId) {
  const id = me();
  M.open = M.open === mailId ? 0 : mailId;
  renderMail(box);
  if (!M.open || M.bodies.has(mailId)) return;
  try {
    const d = await ctx.esiAuthFetch(`/characters/${id}/mail/${mailId}/`);
    M.bodies.set(mailId, mailText(d.body));
  } catch (error) {
    M.bodies.set(mailId, '正文读取失败：' + error.message);
  }
  if (still('mail', id)) renderMail(box);
}

// ---------- 入口 ----------
const RENDER = { clones: renderClones, mining: renderMining, research: renderResearch, fleet: renderFleet, corp: renderCorp, mail: renderMail };
export const MORE_TABS = Object.keys(RENDER);

export async function renderMore(tab, box) {
  if (!box.dataset.moreBound) {
    box.dataset.moreBound = '1';
    box.addEventListener('click', (e) => {
      const view = e.target.closest('[data-more-view]');
      if (view) {
        const [tab, v] = view.dataset.moreView.split(':');
        if (tab === 'corp') S.corpView = v; else S.fleetView = v;
        if (ctx.isActive(tab)) RENDER[tab](box);
        return;
      }
      const reload = e.target.closest('[data-more-reload]');
      if (reload) { const key = reload.dataset.moreReload; cache.delete(key); const tab = key.split(':')[0]; if (ctx.isActive(tab)) RENDER[tab](box); return; }
      const mail = e.target.closest('[data-mail]');
      if (mail) { openMail(box, Number(mail.dataset.mail)); return; }
      const ml = e.target.closest('[data-mail-label]');
      if (ml) { M.label = Number(ml.dataset.mailLabel); M.list = []; M.open = 0; renderMail(box); return; }
      if (e.target.closest('[data-mail-more]')) { if (!M.loading) renderMail(box, true); return; }
      if (e.target.closest('[data-mail-reload]')) { M.list = []; M.labels = null; M.open = 0; renderMail(box); return; }
      const sys = e.target.closest('[data-map-sys]');
      if (sys) { ctx.openMapSystem(Number(sys.dataset.mapSys)); return; }
      const fuel = e.target.closest('[data-fuel-toggle]');
      if (fuel && corpPaint) { FP.toggle(Number(fuel.dataset.fuelToggle) || undefined); corpPaint(); return; }
      if (corpPaint && FP.onClick(e, box, corpPaint)) return;
      const sf = e.target.closest('[data-sf-open]');
      if (sf) {
        const id = Number(sf.dataset.sfOpen);
        const open = !SF_OPEN.has(id);
        if (open) SF_OPEN.add(id); else SF_OPEN.delete(id);
        sf.classList.toggle('open', open);
        sf.setAttribute('aria-expanded', open);
        sf.nextElementSibling.hidden = !open;
        return;
      }
      const dest = e.target.closest('[data-game-dest]');
      if (dest) ctx.game.waypoint(Number(dest.dataset.gameDest));
    });
    // 统一添油：输入时只重算结果，不重画输入框
    box.addEventListener('input', (e) => FP.onInput(e, box));
    // 切换估值价格来源
    box.addEventListener('change', (e) => {
      const src = e.target.closest('[data-val-src]');
      if (!src) return;
      ctx.valuation.set(src.value);
      if (ctx.isActive(src.dataset.valSrc)) RENDER[src.dataset.valSrc](box);
    });
  }
  await RENDER[tab](box);
}
