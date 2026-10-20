// ===== 个人中心 · 克隆 / 挖矿 / 研究 / 舰队 / 军团 =====
//   克隆  /characters/{id}/clones/ + /implants/（esi-clones.*，原有权限）：跳跃克隆位置与植入体、下次可跳时间
//   挖矿  /characters/{id}/mining/（esi-industry.read_character_mining.v1，原有权限）：最近 30 天挖矿记录，按所选交易中心（或全宇宙）的最低卖 / 最高收估值
//   研究  /characters/{id}/agents_research/（「研究代理人」权限）：研究点数 = 余数 + 每日点数 × 开始以来的天数
//   舰队  /characters/{id}/fleet/ → /fleets/{fleet_id}/members/（「舰队」权限，读成员需要是舰队指挥）
//   军团  /characters/{id}/roles/ + 军团钱包 / 订单 / 工业 / 建筑 / 月矿 / 资产（「军团管理」权限，且需相应军团职位）
// 数据按角色缓存 5 分钟，切换角色时清空。

let ctx;
const cache = new Map();   // `${tab}:${key}` -> { id, at, promise }
const TTL = 5 * 60e3;
const CORP_VIEWS = [
  ['wallets', '钱包', '会计 / 初级会计'], ['orders', '订单', '会计 / 交易员'], ['jobs', '工业任务', '工厂管理员'],
  ['structures', '建筑', '空间站管理员'], ['moons', '月矿', '空间站管理员'], ['assets', '资产', '总监']
];
const S = { corpView: 'wallets', fleetView: 'ships' };
const SKILL_INFOMORPH = 33399;   // 意识同步：每级缩短跳跃克隆冷却 1 小时

export function initProfileMore(context) {
  ctx = context;
  window.addEventListener('eve-account-change', () => cache.clear());
}

const esc = (s) => ctx.esc(s);
const val0 = () => ctx.valuation.region();
const me = () => ctx.tokenInfo()?.character_id;
const loading = (text) => `<div class="pi-loading">${esc(text)}</div>`;
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
function cached(key, fn) {
  const id = me();
  const hit = cache.get(key);
  if (hit && hit.id === id && Date.now() - hit.at < TTL) return hit.promise;
  const promise = fn(id);
  cache.set(key, { id, at: Date.now(), promise });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}
// 渲染前确认仍停留在该页、角色没变
const still = (tab, id) => ctx.isActive(tab) && me() === id;

// ---------- 克隆 ----------
async function renderClones(box) {
  const id = me();
  if (!ctx.hasScope('esi-clones.read_clones.v1')) { box.innerHTML = '<p class="text-muted">授权里没有克隆权限（esi-clones.read_clones.v1），重新绑定 ESI 后可查看</p>'; return; }
  box.innerHTML = loading('读取跳跃克隆与植入体…');
  let data;
  try {
    data = await cached('clones', async (cid) => {
      const [clones, implants, skills] = await Promise.all([
        ctx.esiAuthFetch('/characters/' + cid + '/clones/'),
        ctx.hasScope('esi-clones.read_implants.v1') ? ctx.esiAuthFetch('/characters/' + cid + '/implants/').catch(() => []) : Promise.resolve(null),
        ctx.getCharacterSkills().catch(() => null)
      ]);
      const types = await ctx.resolveTypeNames([...(implants || []), ...(clones.jump_clones || []).flatMap((c) => c.implants || [])]);
      const locs = [clones.home_location?.location_id, ...(clones.jump_clones || []).map((c) => c.location_id)].filter(Boolean);
      await ctx.resolveStructureNames(locs).catch(() => {});
      return { clones, implants, skills, types };
    });
  } catch (error) { if (still('clones', id)) box.innerHTML = fail('克隆', error); return; }
  if (!still('clones', id)) return;
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
      ctx.valuationCard('跳跃克隆', jc.length + ' 个', '不含当前使用的克隆') +
      ctx.valuationCard('下次可跳克隆', next > Date.now() ? left(next - Date.now()) + '后' : '现在可跳', `冷却 ${24 - sync} 小时（意识同步 ${sync} 级）${last ? ' · 上次 ' + fmtDate(clones.last_clone_jump_date) : ''}`, next > Date.now() ? 'is-sell' : 'is-buy') +
      ctx.valuationCard('医疗克隆', esc(ctx.locationName(clones.home_location?.location_id)), stationChange > Date.now() ? `远程更换冷却还剩 ${left(stationChange - Date.now())}` : '可以远程更换') +
    '</div>' +
    '<section class="info-section"><h4 class="info-section-title">当前植入体</h4>' + (implants ? implantList(implants) : '<p class="text-muted">授权里没有植入体权限</p>') + '</section>' +
    '<section class="info-section"><h4 class="info-section-title">跳跃克隆</h4>' +
      (jc.length ? jc.map((c) => `<div class="clone-card"><div class="clone-head"><b>${esc(c.name || '跳跃克隆')}</b><span>${esc(ctx.locationName(c.location_id))}</span>
        <button class="link-btn" data-game-dest="${c.location_id}" title="在游戏里设为目的地">设目的地</button></div>${implantList(c.implants)}</div>`).join('')
        : '<p class="text-muted">没有跳跃克隆</p>') +
    '</section>';
}

// ---------- 挖矿 ----------
async function renderMining(box) {
  const id = me();
  if (!ctx.hasScope('esi-industry.read_character_mining.v1')) { box.innerHTML = '<p class="text-muted">授权里没有挖矿记录权限（esi-industry.read_character_mining.v1），重新绑定 ESI 后可查看</p>'; return; }
  box.innerHTML = loading('读取挖矿记录…');
  let data;
  try {
    data = await cached('mining', async (cid) => {
      const rows = await ctx.esiAuthFetchPaged('/characters/' + cid + '/mining/', 10);
      const types = await ctx.resolveTypeNames(rows.map((r) => r.type_id));
      return { rows, types };
    });
  } catch (error) { if (still('mining', id)) box.innerHTML = fail('挖矿记录', error); return; }
  if (!still('mining', id)) return;
  const { rows, types } = data;
  if (!rows.length) { box.innerHTML = '<p class="text-muted">最近 30 天没有挖矿记录</p>'; return; }
  const val = await ctx.valuation.items(rows, (d, t) => { if (t > d && still('mining', id)) box.innerHTML = loading(`读取${val0().hub.name}行情 ${d}/${t}…`); });
  if (!still('mining', id)) return;
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
      ctx.valuationCard('日均', ctx.formatISK(val.sell / byDay.size) + ' ISK', '按最低卖价，有挖矿的日子') +
    '</div>' +
    '<section class="info-section"><h4 class="info-section-title">按矿种</h4>' + table(['矿种', '数量', '最低卖价估值', '最高收价估值', '占比'], typeRows) + '</section>' +
    '<section class="info-section"><h4 class="info-section-title">按日期</h4>' + table(['日期', '星系', '数量', '最低卖价估值', '最高收价估值'], dayRows) + '</section>' +
    `<p class="text-muted valuation-note">按${esc(val.region.hub.name)}的矿石原价估值（未精炼）。ESI 挖矿记录保留最近 30 天，游戏里约每 10 分钟更新一次。</p>`;
}

// ---------- 研究代理人 ----------
let npcPromise = null;
function npcStations() {
  if (!npcPromise) npcPromise = fetch('./npc-data.json?v=2').then((r) => r.json()).then((d) => new Map(d.npcs.map((n) => [n[0], { station: n[4], system: n[5], corp: n[3] }]))).catch(() => { npcPromise = null; return new Map(); });
  return npcPromise;
}
async function renderResearch(box) {
  const id = me();
  if (!ctx.hasScopeGroup('research')) { box.innerHTML = ctx.scopeNeededHtml('research', '查看研究代理人'); return; }
  box.innerHTML = loading('读取研究代理人…');
  let data;
  try {
    data = await cached('research', async (cid) => {
      const [list, npcs] = await Promise.all([ctx.esiAuthFetch('/characters/' + cid + '/agents_research/'), npcStations()]);
      const types = await ctx.resolveTypeNames(list.map((r) => r.skill_type_id));
      return { list, npcs, types };
    });
  } catch (error) { if (still('research', id)) box.innerHTML = fail('研究代理人', error); return; }
  if (!still('research', id)) return;
  const { list, npcs, types } = data;
  if (!list.length) { box.innerHTML = '<p class="text-muted">没有正在进行的研究（在研究代理人处开始研究后显示）</p>'; return; }
  const now = Date.now();
  const rows = list.map((r) => {
    const days = (now - new Date(r.started_at).getTime()) / 86400e3;
    return { ...r, rp: r.remainder_points + r.points_per_day * days, days, npc: npcs.get(r.agent_id) };
  }).sort((a, b) => b.rp - a.rp);
  const totalDay = rows.reduce((t, r) => t + r.points_per_day, 0);
  box.innerHTML =
    '<div class="valuation-grid">' +
      ctx.valuationCard('研究代理人', rows.length + ' 名', '') +
      ctx.valuationCard('累计研究点', ctx.formatNumber(Math.floor(rows.reduce((t, r) => t + r.rp, 0))) + ' RP', '按开始时间推算到现在', 'is-buy') +
      ctx.valuationCard('每日合计', ctx.formatNumber(Math.round(totalDay * 100) / 100) + ' RP', '') +
    '</div>' +
    table(['代理人', '地点', '研究领域', '每日', '当前研究点', '开始于'], rows.map((r) => tr([
      `<b>${esc(ctx.officialName(r.agent_id) || '代理人 ' + r.agent_id)}</b>${r.npc ? `<span class="cell-sub">${esc(ctx.officialName(r.npc.corp) || '')}</span>` : ''}`,
      r.npc ? `<button class="link-btn trade-loc" data-map-sys="${r.npc.system}" title="在星图中查看">${esc(r.npc.station ? ctx.locationName(r.npc.station) : ctx.officialName(r.npc.system) || '')}</button>` : '—',
      esc(types.get(r.skill_type_id) || 'Type ' + r.skill_type_id),
      ctx.formatNumber(Math.round(r.points_per_day * 100) / 100),
      `<strong class="up">${ctx.formatNumber(Math.floor(r.rp))}</strong>`,
      esc(fmtDate(r.started_at, false)) + `<span class="cell-sub">${Math.floor(r.days)} 天</span>`])), 'trade-table') +
    '<p class="text-muted valuation-note">研究点 = 开始时的余数 + 每日点数 × 已过天数；可在代理人处兑换数据核心。</p>';
}

// ---------- 舰队 ----------
async function renderFleet(box) {
  const id = me();
  if (!ctx.hasScopeGroup('fleet')) { box.innerHTML = ctx.scopeNeededHtml('fleet', '查看舰队'); return; }
  box.innerHTML = loading('读取舰队…');
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
        membersError = error.status === 403 || error.status === 404 ? '只有舰队指挥（舰队 Boss）能读取成员列表' : error.message;
      }
      const wings = members ? await ctx.esiAuthFetch('/fleets/' + fleet.fleet_id + '/wings/?language=zh').catch(() => []) : [];
      const types = members ? await ctx.resolveTypeNames(members.map((m) => m.ship_type_id)) : new Map();
      const names = members ? (await ctx.resolveNames(members.map((m) => m.character_id)).catch(() => ({ names: new Map() }))).names : new Map();
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
        esc(names.get(m.character_id) || m.character_id), typeCell(types, m.ship_type_id), esc(ctx.officialName(m.solar_system_id) || m.solar_system_id) + (m.station_id ? '<span class="cell-sub">停靠中</span>' : ''),
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
    const list = await ctx.esiAuthFetchPaged(`/corporations/${corp}/structures/?language=zh`, 5);
    const types = await ctx.resolveTypeNames(list.map((s) => s.type_id));
    await ctx.resolveStructureNames(list.map((s) => s.structure_id)).catch(() => {});
    return { list, types };
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
    return '<div class="valuation-grid">' + ctx.valuationCard('建筑', d.list.length + ' 座', '') +
      ctx.valuationCard('燃料不足 7 天', soon.length + ' 座', soon.length ? '需要尽快补充燃料' : '全部充足', soon.length ? 'is-sell' : 'is-buy') + '</div>' +
      table(['建筑', '类型', '星系', '燃料', '状态', '服务'], [...d.list].sort((a, b) => (a.fuel_expires ? new Date(a.fuel_expires) : Infinity) - (b.fuel_expires ? new Date(b.fuel_expires) : Infinity)).map((s) => {
        const ms = s.fuel_expires ? new Date(s.fuel_expires) - Date.now() : null;
        const fuel = ms == null ? '<span class="muted-cell">无燃料 / 低功率</span>' : `<span class="${ms < 3 * 86400e3 ? 'down' : ms < 7 * 86400e3 ? 'warn-text' : 'up'}">${left(ms)}</span><span class="cell-sub">${esc(fmtDate(s.fuel_expires))}</span>`;
        const services = (s.services || []).map((x) => `<span class="pill${x.state === 'online' ? ' buy' : ''}">${esc(x.name)}</span>`).join(' ');
        return tr([`<b>${esc(s.name || locationName(s.structure_id))}</b>`, esc(d.types.get(s.type_id) || s.type_id), `<button class="link-btn" data-map-sys="${s.system_id}">${esc(ctx.officialName(s.system_id) || s.system_id)}</button>`,
          fuel, esc(STRUCT_STATE[s.state] || s.state) + (s.state_timer_end ? `<span class="cell-sub">计时 ${esc(fmtDate(s.state_timer_end))}</span>` : ''), services || '—']);
      }), 'trade-table');
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
    '<div class="valuation-grid section-gap">' + ctx.valuation.cards(val, '资产估值') + ctx.valuationCard('资产条目', formatNumber(d.count) + ' 项', d.kinds + ' 种物品，蓝图副本不计') + '</div>' +
    table(['物品', '数量', '最低卖价估值', '最高收价估值'], top.map((t) => tr([typeCell(types, t.type_id), formatNumber(t.quantity), formatISK(t.sell), formatISK(t.buy)]))) +
    (d.list.length > 200 ? `<p class="text-muted valuation-note">只列出按最低卖价估值最高的 200 种</p>` : '');
}

async function renderCorp(box) {
  const id = me();
  if (!ctx.hasScopeGroup('corp')) { box.innerHTML = ctx.scopeNeededHtml('corp', '查看军团钱包、订单、工业、建筑、月矿与资产'); return; }
  box.innerHTML = loading('读取军团职位…');
  let base;
  try { base = await cached('corp:base', corpBase); } catch (error) { if (still('corp', id)) box.innerHTML = fail('军团职位', error); return; }
  if (!still('corp', id)) return;
  if (base.corp < 2000000) { box.innerHTML = '<p class="text-muted">当前在 NPC 军团，没有军团管理数据</p>'; return; }
  const roles = base.roles.map((r) => ROLE_ZH[r] || r);
  const view = S.corpView;
  box.innerHTML =
    `<p class="corp-roles">军团职位：${roles.length ? roles.map((r) => `<span class="pill">${esc(r)}</span>`).join(' ') : '<span class="text-muted">没有职位（大部分军团数据需要相应职位）</span>'}</p>` +
    `<div class="valuation-toolbar section-gap"><div class="segmented" role="group">${CORP_VIEWS.map(([k, l]) => `<button data-more-view="corp:${k}" class="${view === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="toolbar-spacer"></span><button class="btn btn-ghost" data-more-reload="corp:${view}">刷新</button></div>` +
    `<div data-corp-body>${loading('读取中…')}</div>`;
  const body = box.querySelector('[data-corp-body]');
  try {
    const d = await cached('corp:' + view, () => CORP_LOAD[view](base.corp));
    const alive = () => still('corp', id) && S.corpView === view;
    if (alive()) { if (view === 'assets') await corpAssets(d, body, alive); else body.innerHTML = corpBody(view, d); }
  } catch (error) {
    if (!still('corp', id) || S.corpView !== view) return;
    const need = CORP_VIEWS.find((v) => v[0] === view)[2];
    body.innerHTML = error.status === 403 ? `<p class="text-muted">没有权限读取：需要军团职位「${esc(need)}」</p>` : fail('军团数据', error);
  }
}

// ---------- 入口 ----------
const RENDER = { clones: renderClones, mining: renderMining, research: renderResearch, fleet: renderFleet, corp: renderCorp };
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
      const sys = e.target.closest('[data-map-sys]');
      if (sys) { ctx.openMapSystem(Number(sys.dataset.mapSys)); return; }
      const dest = e.target.closest('[data-game-dest]');
      if (dest) ctx.game.waypoint(Number(dest.dataset.gameDest));
    });
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
