// 驾驶模拟 · 舰队：舰队窗口（客户端 fleetwindow：「我的舰队」「广播」「阵型」三页 + 底部广播条 FleetBroadcastCont）、
// 广播窗口（广播历史 BroadcastHistoryPanel 单独拖出来的样子）、关注列表（WatchListPanel）、舰队编制窗口（FleetCompositionWindow）。
// 编制照客户端：舰队 → 联队 → 中队，各有一个指挥官位；右键菜单照 fleet.py / menusvc.FleetMenu / fleetwindow.GetFleetMenuTop 的条目和顺序；
// 带领舰队 / 联队 / 中队跃迁（menusvc WarpFleet / WarpFleetToMember）：下属里同一网格、接受舰队跃迁的船一起跃迁。
// 只读客户端界面代码后重写，没有搬代码；文字取自客户端本地化（UI/Fleet/...）。
let H = null;   // 钩子：{ S, root(), esc, tr, UI, typeName, groupName, icon(v), pick(i, e), menu(items, e), lock(v), warpTo(tgt, d), warpD(), setWarpD(d), unitMenu(v, bare), sysName, log, openWin(id) }
export function initFleet(hooks) { H = hooks; }

const IMG = (p) => `${H.UI}${p}?v=1`;
// 广播类型：[图标（classes/fleet/broadcast/16|32/）, 命令名（UI/Fleet/FleetBroadcast/Commands/...）]
const BC = {
  enemy: ['enemyspotted', '广播：发现敌舰'],
  armor: ['needarmor', '广播：需要装甲'],
  shield: ['needshield', '广播：需要护盾'],
  cap: ['needcapacitor', '广播：需要电容'],
  inpos: ['inposition', '广播：已经就位于'],
  backup: ['needbackup', '广播：需要支援'],
  hold: ['holdposition', '广播：要求舰队原地待命'],
  loc: ['locationpin', '广播：位于该处'],
  target: ['target', '广播：锁定'],
  heal: [null, '广播：维修目标'],
  warp: ['warpto', '广播：跃迁到'],
  align: ['alignto', '广播：朝向该处'],
};
// 广播条上的 8 个按钮（broadcastButtonIDs 的顺序）
const BAR = ['enemy', 'armor', 'shield', 'cap', 'inpos', 'backup', 'hold', 'loc'];
const bcIcon = (k, px = 16) => (k === 'heal' ? IMG('eveicon/system_icons/heal_first_aid_16px.png') : IMG(`classes/fleet/broadcast/${px}/${BC[k][0]}.png`));
// 职务（UI/Fleet/Ranks/...）和图标（fleet.py GetMemberData：统帅 73_20，舰队 / 联队 / 中队指挥官 73_17 / 18 / 19，拒绝舰队跃迁等 73_47）
const RANK = { fc: '舰队指挥官', wc: '联队指挥官', sc: '中队指挥官', sm: '中队队员' };
const RICON = { fc: '73_16_17', wc: '73_16_18', sc: '73_16_19' };
const BOSS = '73_16_20', OPTOUT = '73_16_47';
const CMDR = ['fc', 'wc', 'sc'];
// 阵型（evefleet FLEET_FORMATIONS 的顺序；名字 / 说明：UI/Fleet/FleetFormations/...，图标 classes/fleet/fleetformations/）
const FORMS = [
  ['point', '定点', '在一个较小球体中随机排列舰船。'],
  ['sphere', '球状', '由指挥官将舰队随机排列在一个球形区域中，并调整规模。'],
  ['plane', '水平', '由指挥官将舰队排列在一个横向长方形区域中，并调整规模和间隔距离。如果舰队的舰船数量过多，则一些舰船将排在临近的位置。'],
  ['wall', '竖直', '由指挥官将舰队排列在一个纵向长方形区域中，并调整规模和间隔距离。如果舰队的舰船数量过多，则一些舰船将排在临近的位置。'],
  ['arrow', '箭头', '使舰船排列成面向前方的楔形，指挥官可以调整舰队规模和间距。如果舰队的舰船数量过多，则一些舰船将排在临近的位置。'],
  ['relative', '关联', '跃迁时保持舰船在舰队中的位置，与指挥官带领的跃迁相关联。关联阵型有200km距离限制，不会使成员在跃迁时离开这个范围之外。'],
];
// 广播接收范围（fleetBroadcastCont ICONS_BY_SCOPE；循环顺序照 fleetSvc.CycleBroadcastScope：我的队伍 → 上级 → 每个人）
const SCOPE = { all: ['每个人', '73_16_29'], down: ['我的队伍', '73_16_28'], up: ['上级', '73_16_27'] };
const SCOPE_NEXT = { down: 'up', up: 'all', all: 'down' };
const WARP_DISTS = [0, 10000, 20000, 30000, 50000, 70000, 100000];   // movementFunctions.GetWarpToRanges
const GRID = 8e6;
const MIN_BROADCAST_TIME = 2;   // fleetSvc：同一种广播 2 秒一次，不同种 2 / 3 秒
const clock = () => new Date().toISOString().slice(11, 19);   // 客户端写的是 EVE 时间（UTC）时:分:秒
const km = (d) => (d ? `${d / 1000} km` : '0 m');

// ---------- 状态 ----------
function newFleet(keys, fc) {
  return {
    in: [...keys], boss: fc, fc, nw: 2, ns: 2, auto: 1,
    wings: [{ id: 1, name: null, cmd: null, squads: [{ id: 1, name: null, cmd: null, mem: keys.filter((k) => k !== fc) }] }],
    shut: new Set(), flat: false, left: false, edit: null,
    opt: { warp: true, conduit: true, regroup: true }, form: 'point', scope: 'all', hide: new Set(), ignore: new Set(), sent: { k: null, t: -1e9 },
    hist: [], mem: [], last: null, flashAt: 0, mark: new Map(), watch: [], tab: 'fleet', filter: 'bc', btns: true, cool: new Map(), ctab: 'comp',
  };
}
// opt.virt：不在场上的成员（例如在别处指挥的队长）[{ name, ship, fc }]；opt.fc：场上哪个单位是舰队指挥官（单位序号）
export function fleetReset(opt = {}) {
  const S = H.S;
  const virt = (opt.virt || []).map((x, k) => ({ ...x, name: H.tr(x.name), key: 'v' + k }));
  const keys = [...S.b.units.filter((u) => u.side === S.me.side && !u.isDrone).map((u) => 'u' + u.i), ...virt.map((v) => v.key)];
  const fc = opt.fc != null ? 'u' + opt.fc : virt.find((x) => x.fc)?.key || 'u' + S.me.i;
  S.fleet = Object.assign(newFleet(keys, fc), { virt });
  const t = clock();
  for (const m of members()) S.fleet.mem.unshift({ t, label: `${m.name}以${rankName(m.key)}身份加入` });
}
export const fleetOn = () => { const S = H?.S; return Boolean(S?.fleet && S.b && S.me && (S.b.units.some((u) => u !== S.me && u.side === S.me.side && !u.isDrone) || S.fleet?.virt?.length)); };
const inFleet = () => Boolean(H.S.fleet && !H.S.fleet.left);
const meKey = () => 'u' + H.S.me.i;
const unitByKey = (k) => (k?.[0] === 'u' ? H.S.b.units[Number(k.slice(1))] : null);
function memberOf(k) {
  const S = H.S, u = unitByKey(k);
  if (u) return { key: k, u, name: S.names[u.i], ship: u.r.row.ship };
  const v = S.fleet.virt?.find((x) => x.key === k);
  return v ? { key: k, u: null, name: v.name, ship: v.ship } : null;
}
function members() { const F = H.S.fleet; return F && !F.left ? F.in.map(memberOf).filter(Boolean) : []; }
const nameByKey = (k) => memberOf(k)?.name || '';
const isMember = (k) => inFleet() && H.S.fleet.in.includes(k);
// 编制里的位置：{ r: 'fc' | 'wc' | 'sc' | 'sm', w, s }
function posOf(k) {
  const F = H.S.fleet;
  if (!F || !F.in.includes(k)) return { r: null };
  if (F.fc === k) return { r: 'fc' };
  for (const w of F.wings) {
    if (w.cmd === k) return { r: 'wc', w };
    for (const s of w.squads) {
      if (s.cmd === k) return { r: 'sc', w, s };
      if (s.mem.includes(k)) return { r: 'sm', w, s };
    }
  }
  return { r: null };
}
const rankName = (k) => (RANK[posOf(k).r] || RANK.sm) + (H.S.fleet?.boss === k ? '（统帅）' : '');
// 联队 / 中队默认名：按编号排第几（fleet.py GroupNumber）
const wingName = (w) => w.name || `联队${H.S.fleet.wings.indexOf(w) + 1}`;
const squadName = (s, w = H.S.fleet.wings.find((x) => x.squads.includes(s))) => s.name || `中队${(w?.squads.indexOf(s) ?? 0) + 1}`;
const squadN = (s) => (s.cmd ? 1 : 0) + s.mem.length;
const wingN = (w) => (w.cmd ? 1 : 0) + w.squads.reduce((a, s) => a + squadN(s), 0);
const findWing = (id) => H.S.fleet.wings.find((w) => w.id === id);
const findSquad = (id) => { for (const w of H.S.fleet.wings) { const s = w.squads.find((x) => x.id === id); if (s) return { w, s }; } return null; };
// 下属：舰队指挥官 = 全舰队，联队指挥官 = 本联队，中队指挥官 = 本中队
function subs(k) {
  const p = posOf(k), F = H.S.fleet;
  if (p.r === 'fc') return F.in.filter((x) => x !== k);
  if (p.r === 'wc') return p.w.squads.flatMap((s) => [s.cmd, ...s.mem]).filter(Boolean);
  if (p.r === 'sc') return [...p.s.mem];
  return [];
}
const amBoss = () => H.S.fleet?.boss === meKey();
const myRole = () => posOf(meKey()).r;
const cmdrOrBoss = () => amBoss() || CMDR.includes(myRole());
// 能不能调配这个人：统帅、舰队指挥官随便调；联队指挥官只调本联队里的人
function canMove(k) {
  if (amBoss() || myRole() === 'fc') return true;
  const p = posOf(meKey());
  return p.r === 'wc' && posOf(k).w === p.w;
}

// ---------- 编制变动（客户端由服务器做，这里直接改）----------
function detach(k) {
  const F = H.S.fleet;
  if (F.fc === k) F.fc = null;
  for (const w of F.wings) {
    if (w.cmd === k) w.cmd = null;
    for (const s of w.squads) { if (s.cmd === k) s.cmd = null; s.mem = s.mem.filter((x) => x !== k); }
  }
}
// dest：{ r: 'fc' } | { r: 'wc', w } | { r: 'sc', s } | { r: 'sm', s }；指挥官位有人就不行
function place(k, dest) {
  const F = H.S.fleet, before = rankName(k);
  if (dest.r === 'fc' && F.fc && F.fc !== k) return false;
  if (dest.r === 'wc' && dest.w.cmd && dest.w.cmd !== k) return false;
  if (dest.r === 'sc' && dest.s.cmd && dest.s.cmd !== k) return false;
  detach(k);
  if (dest.r === 'fc') F.fc = k;
  else if (dest.r === 'wc') dest.w.cmd = k;
  else if (dest.r === 'sc') dest.s.cmd = k;
  else dest.s.mem.push(k);
  if (rankName(k) !== before) memLog(`${nameByKey(k)}现在的身份是${RANK[dest.r]}`);
  renderFleet(true);
  return true;
}
const memLog = (label) => { const F = H.S.fleet; F.mem.unshift({ t: clock(), label }); if (F.mem.length > 100) F.mem.pop(); };
function join(k, dest) {
  const F = H.S.fleet;
  if (F.in.includes(k)) return;
  F.in.push(k);
  const s = dest?.s || findSquad(F.auto)?.s || F.wings[0]?.squads[0];
  if (!dest || dest.r === 'sm' || !place(k, dest)) { if (s) s.mem.push(k); else if (!F.fc) F.fc = k; }
  memLog(`${nameByKey(k)}以${rankName(k)}身份加入`);
  renderFleet(true);
}
function kick(k) {
  const F = H.S.fleet;
  if (k === meKey()) { leave(); return; }
  detach(k);
  F.in = F.in.filter((x) => x !== k);
  F.watch = F.watch.filter((x) => x !== k);
  if (F.boss === k) F.boss = F.fc || F.in[0] || null;
  memLog(`${nameByKey(k)}离开了舰队`);
  renderFleet(true);
}
function leave() {
  const F = H.S.fleet;
  Object.assign(F, { left: true, hist: [], mem: [], last: null, mark: new Map(), watch: [], tab: 'fleet' });
  H.log?.('你离开了舰队。', 'sys');
  renderFleet(true);
}
// 组建舰队（StartNewFleet）：自己当统帅兼舰队指挥官，一个联队一个中队
function formFleet() {
  const F = H.S.fleet, keep = { virt: F.virt, cool: F.cool };
  H.S.fleet = Object.assign(newFleet([meKey()], meKey()), keep);
  memLog(`${nameByKey(meKey())}以${rankName(meKey())}身份加入`);
  renderFleet(true);
}
function makeBoss(k) {
  const F = H.S.fleet, old = F.boss;
  F.boss = k;
  if (old) memLog(`${nameByKey(old)}不再是舰队统帅`);
  memLog(`${nameByKey(k)}现在是舰队统帅`);
  renderFleet(true);
}
function createWing() {
  const F = H.S.fleet, w = { id: F.nw++, name: null, cmd: null, squads: [] };
  F.wings.push(w);
  createSquad(w);   // fleetSvc.CreateWing：新联队带一个中队
}
function createSquad(w) { w.squads.push({ id: H.S.fleet.ns++, name: null, cmd: null, mem: [] }); renderFleet(true); }
// 解散联队 / 中队：里面的人回到默认中队（客户端由服务器处理，有人的时候是否允许不清楚）
function deleteWing(w) {
  const F = H.S.fleet, ppl = [w.cmd, ...w.squads.flatMap((s) => [s.cmd, ...s.mem])].filter(Boolean);
  F.wings = F.wings.filter((x) => x !== w);
  rehome(ppl);
}
function deleteSquad(w, s) {
  const ppl = [s.cmd, ...s.mem].filter(Boolean);
  w.squads = w.squads.filter((x) => x !== s);
  rehome(ppl);
}
function rehome(ppl) {
  const F = H.S.fleet;
  if (!findSquad(F.auto)) F.auto = F.wings[0]?.squads[0]?.id ?? null;
  for (const k of ppl) { detach(k); const s = findSquad(F.auto)?.s; if (s) s.mem.push(k); else if (!F.fc) F.fc = k; }
  renderFleet(true);
}

// ---------- 跃迁 ----------
// 带领跃迁：下属里还活着、没在跃迁、和自己在同一网格（8000 km 内）的船一起跃迁（AI 队友总是接受舰队跃迁）
// AI 队友临时交给「驾驶」状态（takeControl）走跃迁，落地后交回 AI（fleetTick 里收回）
function aiWarp(u, tgt, d) {
  const B = H.S.b;
  if (u.pilot) return B.warpTo(u, tgt, d) === true;
  B.takeControl(u.i, 0);
  if (B.warpTo(u, tgt, d) !== true) { delete u.pilot; return false; }
  u.fleetWarp = true;
  return true;
}
const dist = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
export function fleetWarp(tgt, d = H.warpD()) {
  const S = H.S, me = S.me;
  if (!CMDR.includes(myRole()) || !me?.alive) return;
  const tu = tgt?.cel == null ? tgt : null;
  for (const k of subs(meKey())) {
    const u = unitByKey(k);
    if (!u || !u.alive || u.warp || u === tu || dist(u, me) > GRID) continue;
    aiWarp(u, tgt, d);
  }
  H.warpTo(tgt, d);
}
// 重组队（fleetSvc.Regroup → 服务器 CmdFleetRegroup，消息「重新集合在{leader}周围」）：同一网格、接受重组的下属跃迁到自己身边
function regroup() {
  const S = H.S, me = S.me;
  for (const k of subs(meKey())) {
    const u = unitByKey(k);
    if (u?.alive && !u.warp && dist(u, me) <= GRID) aiWarp(u, me, 0);
  }
  H.log?.('重组', 'sys');
}
const formName = () => FORMS.find((f) => f[0] === H.S.fleet.form)?.[1] || '定点';
const unitWord = () => ({ fc: '舰队', wc: '联队', sc: '中队' }[myRole()]);
// menusvc.WarpToMenu：七个距离 + 设置默认距离
function warpToMenu(fn) {
  const cur = H.warpD();
  return [...WARP_DISTS.map((d) => [`${km(d)}内`, () => fn(d)]), null,
    ['设置默认距离', WARP_DISTS.map((d) => [km(d), () => H.setWarpD(d), { on: d === cur }])]];
}
// 天体 / 舰船菜单里的带领跃迁（menusvc._GetWarpOptions）；member = 目标是舰队成员（WarpFleetToMember 的文字）
export function warpItems(tgt, member = false) {
  if (!inFleet() || !CMDR.includes(myRole())) return [];
  const w = unitWord(), f = formName();
  return member
    ? [[`带领${w}(${f})跃迁至成员`, () => fleetWarp(tgt)], [`带领${w}(${f})跃迁至距该队员`, warpToMenu((d) => fleetWarp(tgt, d))]]
    : [[`带领${w}(${f})跃迁`, () => fleetWarp(tgt)], [`带领${w}(${f})跃迁至距`, warpToMenu((d) => fleetWarp(tgt, d))]];
}

// ---------- 发广播 ----------
// who：发送者 key（默认自己）；o.u：目标单位（锁定 / 维修目标），o.cel：位置（跃迁到 / 朝向该处 / 已经就位于）
export function broadcast(k, o = {}) {
  const S = H.S, F = S.fleet;
  if (!F || F.left) return;
  const who = o.who || meKey(), c = nameByKey(who), wu = unitByKey(who);
  // 自己发的：同一种 2 秒一次、换一种 0.67 秒（fleetSvc.IsTimeRestricted）
  if (!o.who) {
    const now = performance.now() / 1000, gap = F.sent.k === k ? MIN_BROADCAST_TIME : MIN_BROADCAST_TIME / 3;
    if (now < F.sent.t + gap) return;
    F.sent = { k, t: now };
  }
  // 忽略了的广播类型：指挥链上的人发的照收（fleetbroadcastexports.WantBroadcast）
  if (who !== meKey() && F.ignore.has(k)) {
    const p = posOf(meKey()), wp = posOf(who);
    if (!(wp.r === 'fc' || F.boss === who || (wp.r === 'wc' && wp.w === p.w) || (wp.r === 'sc' && wp.s === p.s))) return;
  }
  const tn = (id) => H.typeName(id);
  const celName = (i) => S.b.cel?.[i]?.name || '';
  let label;
  // 文字：UI/Fleet/FleetBroadcast/BroadcastEvent*（需要装甲 / 护盾 / 电容后面客户端会补「 (船型)」）
  switch (k) {
    case 'enemy': label = `${c}发现敌舰`; break;
    case 'backup': label = `${c}请求支援`; break;
    case 'armor': label = `${c}需要装甲维修${wu ? ` (${tn(wu.r.row.ship)})` : ''}`; break;
    case 'shield': label = `${c}需要护盾回充${wu ? ` (${tn(wu.r.row.ship)})` : ''}`; break;
    case 'cap': label = `${c}需要电容补充${wu ? ` (${tn(wu.r.row.ship)})` : ''}`; break;
    case 'inpos': label = `${c}现在正位于 ${celName(o.cel ?? nearCel(wu))}`; break;
    case 'hold': label = `${c}：原地待命`; break;
    case 'loc': label = `${c}位于${H.sysName() || ''}`; break;
    case 'warp': label = `${c}：跃迁 ${o.cel != null ? celName(o.cel) : S.names[o.u?.i] || ''}`; break;
    case 'align': label = `${c}：船头朝向 ${o.cel != null ? celName(o.cel) : S.names[o.u?.i] || ''}`; break;
    case 'target': label = o.u ? `锁定${S.names[o.u.i]} (${tn(o.u.r.row.ship)})` : '锁定'; break;
    case 'heal': label = o.u ? `维修${S.names[o.u.i]}（${tn(o.u.r.row.ship)}）` : '维修'; break;
    default: return;
  }
  // 广播的对象：锁定 / 维修目标标在目标身上，其余标在发送者身上（总览、关注列表的广播图标）
  const item = k === 'target' || k === 'heal' ? o.u : k === 'warp' || k === 'align' ? o.u || null : wu;
  const cel = k === 'inpos' || k === 'loc' ? o.cel ?? nearCel(wu) : o.cel;
  const e = { t: clock(), k, who, label, u: item?.i ?? null, cel: cel ?? null, scope: who === meKey() ? F.scope : 'all' };
  F.hist.unshift(e);
  if (F.hist.length > 100) F.hist.pop();   // MAX_NUM_BROADCASTS
  F.last = e;
  F.flashAt = performance.now();
  if (item && k !== 'warp' && k !== 'align') F.mark.set(item.i, k);
  else if (wu && (k === 'warp' || k === 'align')) F.mark.set(wu.i, k);
  renderFleet(true);
  return e;
}
function nearCel(u) {
  const cel = H.S.b.cel || [];
  if (!u) return null;
  let best = null, bd = Infinity;
  cel.forEach((c, i) => { const d = dist(c, u); if (d < bd) { bd = d; best = i; } });
  return best;
}
// 总览行、太空里的广播图标：这个单位最近一次被广播的类型
export const markOf = (u) => H.S.fleet?.mark.get(u.i) || null;
export const markIcon = (k) => bcIcon(k);
export const bcName = (k) => BC[k]?.[1] || '';
// 右键菜单里的广播条目：按文字找图标（客户端 MenuEntryData 的 texturePath = iconsByBroadcastType）
export const bcIconOf = (name) => { const k = Object.keys(BC).find((x) => BC[x][1] === name); return k ? bcIcon(k) : null; };
// 快捷键：Z 发现敌舰；按住 X 点目标 = 广播锁定（客户端 CmdFleetBroadcast_EnemySpotted / CmdSendBroadcast_Target）
export function fleetKey(k) {
  if (!inFleet()) return false;
  if (k === 'z') { broadcast('enemy'); return true; }
  return false;
}

// AI 队友：掉血了自己发「需要护盾 / 装甲」（每人 20 秒最多一次）；带跳落地的 AI 交回自动驾驶
export function fleetTick() {
  const S = H.S, F = S.fleet;
  if (!F || !S.b) return;
  for (const u of S.b.units) {
    if (u.fleetWarp && !u.warp && !(u.pilot?.cmd === 'warp' && u.pilot.wp)) { delete u.pilot; u.fleetWarp = false; }
    if (F.left || !F.in.includes('u' + u.i)) continue;
    if (u === S.me || u.side !== S.me.side || !u.alive || u.pilot || u.isDrone) continue;
    const mx = u.t.max, f = (k) => u.hp[k] / (mx[k] || 1);
    const k = mx[0] > 1 && f(0) < 0.5 ? 'shield' : mx[1] > 1 && f(1) < 0.6 ? 'armor' : null;
    if (!k || (F.cool.get(u.i) ?? -1e9) > S.b.t) continue;
    F.cool.set(u.i, S.b.t + 20);
    broadcast(k, { who: 'u' + u.i });
  }
  for (const [i] of F.mark) if (!S.b.units[i]?.alive) F.mark.delete(i);
}

// ---------- 窗口 ----------
// 标题（fleetwindow.UpdateHeader）：舰队指挥官只写人数，联队指挥官加「 / 联队」，其余加「 / 联队 / 中队」
export function fleetTitle() {
  if (!inFleet()) return '舰队';
  const n = members().length, p = posOf(meKey());
  if (p.r === 'fc' || !p.r) return `舰队(${n}个成员)`;
  if (p.r === 'wc') return `舰队(${n}个成员) / ${wingName(p.w)}`;
  return `舰队(${n}个成员) / ${wingName(p.w)} / ${squadName(p.s, p.w)}`;
}
// 页签在标题栏里（客户端 FleetWindow 用 TabNavigationWindowHeader：窗口图标 + 页签，没有标题文字）：
// 舰队 / 广播 / 阵型；客户端还有的重生、广告、搜寻舰队模拟里没有
export const fleetTabsHtml = () => `<span class="pl-fl-tabs"><button type="button" data-fl-tab="fleet">${H.esc(H.tr('舰队'))}</button><button type="button" data-fl-tab="bc">${H.esc(H.tr('广播'))}</button><button type="button" data-fl-tab="form">${H.esc(H.tr('阵型'))}</button></span>`;
export function fleetBody() {
  return `<div class="pl-fl-main" data-fl-main="fleet"></div>${barHtml()}`;
}
export const bcBody = () => `<div class="pl-fl-main" data-fl-main="bc"></div>${barHtml()}`;
export const watchBody = () => '<div class="pl-fl-watch" data-fl-watch></div>';
export const compBody = () => '<div class="pl-ov-tabs pl-fl-tabs"><button type="button" data-fl-ctab="comp" style="--c:#fff">舰队编制</button><button type="button" data-fl-ctab="sum" style="--c:#fff">舰队概况</button></div><div class="pl-fl-comp" data-fl-comp></div>';
const barHtml = () => '<div class="pl-fl-bar" data-fl-bar><div class="pl-fl-ban" data-fl-ban><img class="ic" src="" alt=""><span></span><button type="button" class="arw" data-fl-arw title=""><img src="" alt=""></button></div><div class="pl-fl-btns"></div></div>';

// 每半秒（发广播时马上）刷新；内容没变不重画
export function renderFleet() {
  const root = H.root(), S = H.S, F = S.fleet;
  if (!root || !F) return;
  for (const b of root.querySelectorAll('[data-fl-tab]')) { b.classList.toggle('on', b.dataset.flTab === F.tab); b.hidden = F.left && b.dataset.flTab !== 'fleet'; }
  const role = root.querySelector('[data-fl-myrole]');
  if (role) { const h = myRoleHtml(); if (role.dataset.k !== h) { role.dataset.k = h; role.innerHTML = h; } }
  for (const el of root.querySelectorAll('[data-fl-main]')) {
    if (el.contains(document.activeElement) && document.activeElement.matches('input')) continue;   // 正在改名
    const tab = el.dataset.flMain === 'bc' ? 'bc' : F.left ? 'fleet' : F.tab;
    const html = F.left ? (el.dataset.flMain === 'bc' ? '' : formFleetHtml()) : tab === 'fleet' ? fleetHtml() : tab === 'form' ? formsHtml() : histHtml();
    if (el.dataset.k !== html) { el.dataset.k = html; el.innerHTML = html; const inp = el.querySelector('[data-fl-rename]'); if (inp) { inp.focus(); inp.select(); } }
  }
  for (const el of root.querySelectorAll('[data-fl-bar]')) { el.hidden = F.left; if (!F.left) renderBar(el); }
  const w = root.querySelector('[data-fl-watch]');
  if (w) renderWatch(w);
  const c = root.querySelector('[data-fl-comp]');
  if (c) renderComp(c);
}
const icon16 = (id, hint) => `<img src="${IMG(`icons/${id}.png`)}" alt="" title="${H.esc(H.tr(hint))}">`;
// 成员的职务图标（统帅在前，然后指挥官；自己拒绝舰队跃迁等加 73_47）
function roleIcons(k) {
  const F = H.S.fleet, r = posOf(k).r, out = [];
  if (F.boss === k) out.push(icon16(BOSS, '统帅'));
  if (RICON[r]) out.push(icon16(RICON[r], RANK[r]));
  if (k === meKey()) {
    const no = [!F.opt.warp && '飞行员拒绝舰队跃迁', !F.opt.conduit && '飞行员拒绝导管跳跃', !F.opt.regroup && '飞行员拒绝舰队重组'].filter(Boolean);
    if (no.length) out.push(icon16(OPTOUT, no.join('\n')));
  }
  return out.join('');
}
// 窗口顶上的自己职务图标（FleetRoleCont：指挥官在前、统帅在后）
function myRoleHtml() {
  if (!inFleet()) return '';
  const r = myRole();
  return (RICON[r] ? icon16(RICON[r], RANK[r]) : '') + (amBoss() ? icon16(BOSS, '统帅') : '');
}
function formFleetHtml() {
  const { esc, tr } = H;
  return `<div class="pl-fl-form"><h3>${esc(tr('组建新舰队'))}</h3><p>${esc(tr('宇宙中的多数探险活动更适合与其他克隆飞行员合作完成，包括采矿、战斗和运输。通过组建一支舰队，你可以召集一批人数或多或少的飞行员，通过特定的聊天频道和广播系统进行交流，并可以让整个舰队共同进行跃迁。'))}</p>
    <button type="button" class="pl-btn" data-fl-formfleet>${esc(tr('组建舰队'))}</button></div>`;
}
// 「我的舰队」（fleet.py LoadFleet）：舰队 → 联队 → 中队 → 队员；标题两行（「名称 (人数)」+ 指挥官），自己是指挥官的那一级底色淡绿
// 缩进：标题 4 + 层级 × 16（层级 0 / 1 / 2），队员 20 + 层级 × 16（层级 3）；扁平列表：所有人按名字排，缩进 16
function fleetHtml() {
  const { esc, tr } = H, S = H.S, F = S.fleet, me = meKey();
  const row = (k, lv) => {
    const m = memberOf(k);
    if (!m) return '';
    const left = F.flat ? 16 : 20 + lv * 16;
    return `<div class="pl-fl-m${k === me && !F.flat ? ' me' : ''}${m.u && !m.u.alive ? ' dead' : ''}${m.u && m.u.i === S.sel ? ' sel' : ''}" data-fl-m="${k}" draggable="true" style="padding-left:${left}px"><span>${esc(m.name)}</span><i class="roles">${roleIcons(k)}</i></div>`;
  };
  if (F.flat) return members().sort((a, b) => a.name.localeCompare(b.name)).map((m) => row(m.key, 1)).join('');
  const myP = posOf(me);
  const head = (lv, id, info, n, cmd, mine, arrow, auto) => {
    const c = cmd ? memberOf(cmd) : null;
    const editing = F.edit === id;
    const top = editing ? `<input type="text" maxlength="10" value="${esc(info.name)}" data-fl-rename="${id}">` : `<b${n ? '' : ' class="empty"'}>${esc(tr(info.label))}</b>${auto ? `<img class="auto" src="${IMG('classes/fleet/defaultsquad.png')}" alt="" title="${esc(tr('新成员将默认加入这个中队，除非被指定邀请加入某个中队'))}">` : ''}`;
    return `<div class="pl-fl-h${cmd === me ? ' mine' : ''}${arrow ? ' arw' : ''}${F.shut.has(id) ? ' shut' : ''}${mine && cmd !== me ? ' my' : ''}" data-fl-h="${id}" style="padding-left:${4 + lv * 16}px">${arrow ? '<i class="ex"></i>' : ''}<div class="tx"><div class="t1">${top}</div>`
      + `<div class="t2">${c ? `<span class="pl-fl-cmd" data-fl-m="${cmd}" draggable="true">${esc(c.name)}</span>` : `<span class="none">${esc(tr('（没有指挥官）'))}</span>`}</div></div><i class="roles">${c ? roleIcons(cmd) : ''}</i></div>`;
  };
  const empty = (lv, label, id, auto) => `<div class="pl-fl-none" data-fl-h="${id || ''}" style="padding-left:${20 + lv * 16}px">${esc(tr(label))}${auto ? `<img class="auto" src="${IMG('classes/fleet/defaultsquad.png')}" alt="">` : ''}</div>`;
  let out = head(0, 'f', { label: `舰队 (${members().length})`, name: '' }, members().length, F.fc, true, false);
  for (const w of F.wings) {
    const wid = 'w' + w.id;
    out += head(1, wid, { label: `${wingName(w)} (${wingN(w)})`, name: wingName(w) }, wingN(w), w.cmd, myP.w === w, true);
    if (F.shut.has(wid)) continue;
    if (!w.squads.length) out += empty(2, '（空）', wid);
    for (const s of w.squads) {
      const sid = 's' + s.id, n = squadN(s), auto = F.auto === s.id && cmdrOrBoss();
      if (!n) { out += empty(2, `${squadName(s, w)} (空的)`, sid, auto).replace('class="pl-fl-none"', 'class="pl-fl-none sq"'); continue; }
      out += head(2, sid, { label: `${squadName(s, w)} (${n})`, name: squadName(s, w) }, n, s.cmd, myP.s === s, true, auto);
      if (F.shut.has(sid)) continue;
      // 队员：统帅在前，然后按名字（SquadContentGetter）
      const list = [...s.mem].sort((a, b) => (b === F.boss) - (a === F.boss) || nameByKey(a).localeCompare(nameByKey(b)));
      out += list.map((k) => row(k, 3)).join('') || empty(3, '（空）', sid);
    }
  }
  return out;
}
// 阵型页（FleetFormationsPanel）：六个 26 像素图标按钮，悬停显示名字和说明
function formsHtml() {
  const { esc, tr } = H, F = H.S.fleet;
  return `<div class="pl-fl-forms">${FORMS.map(([k, n, d]) => `<button type="button" class="${F.form === k ? 'on' : ''}" data-fl-form="${k}" title="${esc(`${tr(n + '阵型')}\n${tr(d)}`)}"><img src="${IMG(`classes/fleet/fleetformations/${k}formation.png`)}" alt=""></button>`).join('')}</div>`;
}
// 广播历史：「时:分:秒 - 内容」，新的在上；下拉：全部 / 广播历史记录 / 成员历史
function histHtml() {
  const { esc, tr } = H, F = H.S.fleet;
  if (F.left) return '';
  const opts = [['all', '全部'], ['bc', '广播历史记录'], ['mem', '成员历史']];
  const list = F.filter === 'bc' ? F.hist : F.filter === 'mem' ? F.mem : [...F.hist, ...F.mem];
  const sel = `<select data-fl-filter>${opts.map(([v, l]) => `<option value="${v}"${v === F.filter ? ' selected' : ''}>${esc(tr(l))}</option>`).join('')}</select>`;
  const lines = list.map((e) => `<div class="pl-fl-ev"${e.k ? ` data-fl-ev="${F.hist.indexOf(e)}"` : ''}>${e.k ? `<img src="${bcIcon(e.k)}" alt="">` : '<i></i>'}<span>${esc(e.t)} - ${esc(tr(e.label))}</span></div>`).join('');
  // 客户端 BroadcastHistoryPanel：紧凑下拉框（宽 145，默认「广播历史记录」）+ 右边幽灵按钮「清除」；没有记录时列表中间一行大字提示
  return `<div class="pl-fl-hh">${sel}<button type="button" class="pl-fl-clr" data-fl-clear>${esc(tr('清除'))}</button></div><div class="pl-fl-list">${lines || `<div class="pl-fl-hint">${esc(tr('尚未发生任何事件'))}</div>`}</div>`;
}
// 底部广播条：最近一条（图标 44_32_29 收到新广播闪 3 下）+ 折叠箭头；按钮行：显示的按钮 × 40 + 50 放得下用 32 像素图标；右边接收范围图标、设定齿轮
function renderBar(el) {
  const { esc, tr } = H, F = H.S.fleet;
  const ban = el.querySelector('.pl-fl-ban');
  const txt = F.last ? tr(F.last.label) : tr('（没有广播）');
  const span = ban.querySelector('span');
  if (span.textContent !== txt) span.textContent = txt;
  span.classList.toggle('none', !F.last);
  const ic = ban.querySelector('.ic');
  const isrc = F.last?.k ? bcIcon(F.last.k) : IMG('icons/44_32_29.png');
  if (ic.getAttribute('src') !== isrc) ic.src = isrc;
  ic.classList.toggle('flash', Boolean(F.last) && performance.now() - F.flashAt < 2100);
  ban.title = F.last ? `${tr(F.last.label)}\n${tr('发送者：')}${nameByKey(F.last.who)} ${tr(isMember(F.last.who) ? rankName(F.last.who) : '舰队成员')}\n${tr('接收者：')}${tr(SCOPE[F.last.scope || 'all'][0])}\n${tr('发送时间：')}${F.last.t}` : '';
  const arw = ban.querySelector('.arw');
  arw.title = tr(F.btns ? '隐藏广播按钮' : '显示广播按钮');
  const ai = arw.querySelector('img');
  if (!ai.getAttribute('src')) ai.src = IMG('classes/neocom/arrowup.png');
  arw.classList.toggle('open', F.btns);
  const btns = el.querySelector('.pl-fl-btns');
  btns.hidden = !F.btns;
  const shown = BAR.filter((k) => !F.hide.has(k));
  const px = shown.length && el.offsetWidth > shown.length * 40 + 50 ? 32 : 16;
  const key = `${px}:${shown.join()}:${F.scope}`;
  if (btns.dataset.k !== key) {
    btns.dataset.k = key;
    btns.className = `pl-fl-btns s${px}`;
    btns.innerHTML = shown.map((k) => `<button type="button" data-fl-bc="${k}" title="${esc(tr(BC[k][1]))}"><img src="${bcIcon(k, px)}" alt=""></button>`).join('')
      + `<button type="button" class="scope" data-fl-scope title="${esc(tr(`此广播的接收者（目前范围：${SCOPE[F.scope][0]}）`))}"><img src="${IMG(`icons/${SCOPE[F.scope][1]}.png`)}" alt=""></button>`
      + `<button type="button" class="gear" data-fl-gear title="${esc(tr('设定'))}"><img src="${IMG('eveicon/system_icons/settings_16px.png')}" alt=""></button>`;
  }
}
// 关注列表：舰船图标 16 + 名字 + 广播图标 + 三条血（结构、装甲、护盾，各 22×8）
function renderWatch(el) {
  const { esc, tr } = H, S = H.S, F = S.fleet;
  const list = F.watch.map((k) => memberOf(k)).filter((m) => m?.u);
  const g = (u) => [2, 1, 0].map((k) => Math.max(0, Math.min(1, u.alive ? u.hp[k] / (u.t.max[k] || 1) : 0)));
  const key = JSON.stringify(list.map((m) => [m.key, F.mark.get(m.u.i) || '', g(m.u).map((x) => Math.round(x * 44)), m.u.i === S.sel, rankName(m.key)]));
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  el.innerHTML = list.map((m) => {
    const mk = F.mark.get(m.u.i);
    return `<div class="pl-fl-w${m.u.i === S.sel ? ' sel' : ''}${m.u.alive ? '' : ' dead'}" data-fl-w="${m.key}" title="${esc(tr('舰队职位：') + tr(rankName(m.key)))}"><img class="sh" src="${H.icon(m.u)}" alt=""><span>${esc(m.name)}</span><i class="bc">${mk ? `<img src="${bcIcon(mk)}" alt="">` : ''}</i><i class="hp">${g(m.u).map((f) => `<b style="--f:${f.toFixed(3)}"></b>`).join('')}</i></div>`;
  }).join('') || `<div class="pl-fl-none drop">${esc(tr('将舰队成员投放到此处，以将其加入关注列表'))}</div>`;
}
// 舰队编制窗口：编制页（名字 / 地点 / 舰船类型 / 舰船组 / 舰队职位 / 舰队位置，只列下属，统帅看全部）、概况页（舰船类型 / 舰船组 / 数量）
function renderComp(el) {
  const { esc, tr } = H, F = H.S.fleet, root = H.root();
  for (const b of root.querySelectorAll('[data-fl-ctab]')) b.classList.toggle('on', b.dataset.flCtab === F.ctab);
  let html;
  if (F.left || !cmdrOrBoss()) html = `<div class="pl-fl-none">${esc(tr('要这样做，你必须是舰队统帅或者担当指挥官才行。'))}</div>`;
  else {
    const who = amBoss() ? F.in : subs(meKey());
    const ms = who.map(memberOf).filter(Boolean);
    if (F.ctab === 'comp') {
      const pos = (k) => { const p = posOf(k); return !p.w ? '' : !p.s ? wingName(p.w) : `${wingName(p.w)} / ${squadName(p.s, p.w)}`; };
      const rows = ms.map((m) => `<tr data-fl-m="${m.key}"><td>${esc(m.name)}</td><td>${esc(H.sysName() || '')}</td><td>${esc(H.typeName(m.ship))}</td><td>${esc(H.groupName(m.ship))}</td><td>${esc(tr(rankName(m.key)))}</td><td>${esc(pos(m.key))}</td></tr>`).join('');
      html = `<p class="help">${esc(tr('以下飞行员是你在舰队中的下属。该信息可能存在1分钟的延迟。'))}</p><table><thead><tr>${['名字', '地点', '舰船类型', '舰船组', '舰队职位', '舰队位置'].map((h) => `<th>${esc(tr(h))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><p class="cnt">${ms.length} ${esc(tr('飞行员'))}</p>`;
    } else {
      const by = new Map();
      for (const m of ms) by.set(m.ship, (by.get(m.ship) || 0) + 1);
      const rows = [...by].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<tr><td>${esc(H.typeName(t))}</td><td>${esc(H.groupName(t))}</td><td class="r">${n}</td></tr>`).join('');
      html = `<table><thead><tr>${['舰船类型', '舰船组', '数量'].map((h) => `<th>${esc(tr(h))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  }
  if (el.dataset.k !== html) { el.dataset.k = html; el.innerHTML = html; }
}
export function watchAdd(u, on = true) {
  const F = H.S.fleet, k = 'u' + u.i;
  if (!F) return;
  F.watch = F.watch.filter((x) => x !== k);
  if (on) F.watch.push(k);
  renderFleet(true);
}

// ---------- 菜单 ----------
// 调配队员 / 邀请加入舰队的位置菜单：舰队指挥官 / 联队 ▸（联队指挥官 / 中队 ▸（中队指挥官 / 中队队员））；有人的指挥官位不能选
function posMenu(fn) {
  const F = H.S.fleet;
  return [['舰队指挥官', () => fn({ r: 'fc' }), { off: Boolean(F.fc) }],
    ...F.wings.map((w) => [wingName(w), [['联队指挥官', () => fn({ r: 'wc', w }), { off: Boolean(w.cmd) }],
      ...w.squads.map((s) => [squadName(s, w), [['中队指挥官', () => fn({ r: 'sc', s }), { off: Boolean(s.cmd) }], ['中队队员', () => fn({ r: 'sm', s })]]])]])];
}
// 成员菜单（menusvc.FleetMenu 的条目和顺序）
function memberMenu(k) {
  const S = H.S, F = S.fleet, me = meKey(), u = unitByKey(k), out = [];
  if (!isMember(k)) return out;
  if (k !== me && (amBoss() || canMove(k))) out.push(['将成员踢出舰队', [['确认', () => kick(k)]]]);
  if (k !== me && amBoss()) out.push(['任命为统帅', () => makeBoss(k)]);
  if (k !== me && u) out.push(F.watch.includes(k) ? ['从关注列表中删除', () => watchAdd(u, false)] : ['加入关注列表', () => watchAdd(u, true)]);
  if (k !== me && u?.alive && !u.warp) {
    out.push(['跃迁至该成员处', () => H.warpTo(u, H.warpD())], ['跃迁至距该成员', warpToMenu((d) => H.warpTo(u, d))]);
    out.push(...warpItems(u, true));
  }
  if (k === me) out.push(['离开舰队', [['确认', leave]]]);
  if (canMove(k)) out.push(['调配队员', posMenu((dest) => place(k, dest))]);
  return out;
}
// 成员行右键（fleetUtil.GetFleetMemberMenuOptions）：舰船的常用操作 + 舰队菜单
function memberRowMenu(k) {
  const u = unitByKey(k), out = [];
  if (u && u !== H.S.me && u.alive) out.push(...H.unitMenu(u, true), null);
  out.push(...memberMenu(k));
  return out;
}
// 标题右键（FleetHeader.GetMenu）：指挥官的舰队菜单 + 这一级的菜单
function headerMenu(id) {
  const F = H.S.fleet, out = [];
  const g = id === 'f' ? { cmd: F.fc } : id[0] === 'w' ? findWing(Number(id.slice(1))) : findSquad(Number(id.slice(1)));
  if (!g) return out;
  const cmd = id[0] === 's' ? g.s.cmd : g.cmd;
  if (cmd) out.push(...memberMenu(cmd), null);
  if (id === 'f') {
    if (myRole() !== 'fc') out.push(['离开舰队', leave]);
    if (amBoss() || myRole() === 'fc') out.push(null, ['创建新联队', createWing]); else out.push(null);
    if (CMDR.includes(myRole())) out.push(['重组队', regroup]);
    out.push(['广播：位于该处', () => broadcast('loc')], null,
      ['展开所有联队', () => { for (const w of F.wings) F.shut.delete('w' + w.id); renderFleet(true); }],
      ['收起所有联队', () => { for (const w of F.wings) F.shut.add('w' + w.id); renderFleet(true); }],
      ['展开所有中队', () => { for (const w of F.wings) for (const s of w.squads) F.shut.delete('s' + s.id); renderFleet(true); }],
      ['收起所有中队', () => { for (const w of F.wings) for (const s of w.squads) F.shut.add('s' + s.id); renderFleet(true); }]);
  } else if (id[0] === 'w') {
    if (amBoss() || ['fc', 'wc'].includes(myRole())) out.push(['解散联队', () => deleteWing(g)], ['更改名称', () => { F.edit = id; renderFleet(true); }], ['创建新中队', () => createSquad(g)]);
  } else {
    if (cmdrOrBoss()) {
      out.push(['更改名称', () => { F.edit = id; renderFleet(true); }], ['解散中队', () => deleteSquad(g.w, g.s)]);
      out.push(F.auto === g.s.id ? ['不再作为默认中队', () => { F.auto = null; renderFleet(true); }] : ['设置为默认中队', () => { F.auto = g.s.id; renderFleet(true); }]);
    }
    out.push(['将中队队员加入关注列表', () => { for (const k of [g.s.cmd, ...g.s.mem]) { const u = unitByKey(k); if (u && u !== H.S.me) watchAdd(u, true); } H.openWin?.('watch'); }]);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}
// 窗口「更多」菜单（fleetwindow.GetFleetMenuTop）
export function moreMenu() {
  const F = H.S.fleet;
  if (F.left) return [['组建舰队', formFleet]];
  const out = [['离开舰队', leave]];
  if (CMDR.includes(myRole())) out.push(['重组队', regroup]);
  out.push(['广播', [...BAR.map((k) => [BC[k][1], () => broadcast(k)])]], null);
  out.push([F.flat ? '以分级列表形式查看' : '以直白列表形式查看', () => { F.flat = !F.flat; renderFleet(true); }], null);
  out.push(['接受舰队跃迁', () => { F.opt.warp = !F.opt.warp; renderFleet(true); }, { on: F.opt.warp }],
    ['接受导管跳跃', () => { F.opt.conduit = !F.opt.conduit; renderFleet(true); }, { on: F.opt.conduit }],
    ['接受舰队重组', () => { F.opt.regroup = !F.opt.regroup; renderFleet(true); }, { on: F.opt.regroup }], null);
  if (cmdrOrBoss()) out.push(['显示舰队编制', () => H.openWin?.('fcomp')]);
  out.push(['打开舰队关注列表', () => H.openWin?.('watch')]);
  if (amBoss()) out.push(['解散舰队', leave]);
  return out;
}
// 广播条设定（_GetBroadcastBtnSettings）：要显示的广播按钮（复选）+ 谁会收到我的广播（单选）
function gearMenu() {
  const F = H.S.fleet;
  return [['要显示的广播按钮', null, { lbl: true }],
    ...BAR.map((k) => [BC[k][1], () => { if (F.hide.has(k)) F.hide.delete(k); else F.hide.add(k); renderFleet(true); }, { on: !F.hide.has(k) }]), null,
    ['谁会收到我的广播', null, { lbl: true }],
    ...['all', 'down', 'up'].map((s) => [SCOPE[s][0], () => setScope(s), { radio: F.scope === s }])];
}
function setScope(s) { H.S.fleet.scope = s; H.log?.(`广播的接收者设为${SCOPE[s][0]}`, 'sys'); renderFleet(true); }
// 广播右键（GetLastBroadcastMenu）：按类型的操作 + 舰队成员 ▸ + 忽略这类广播信息
function bcMenu(ev) {
  const S = H.S, F = S.fleet, out = [];
  if (!ev) return out;
  const wu = unitByKey(ev.who), iu = ev.u != null ? S.b.units[ev.u] : null;
  if (['enemy', 'backup', 'inpos'].includes(ev.k) && wu && wu !== S.me && wu.alive) {
    out.push(['跃迁至该成员处', () => H.warpTo(wu, H.warpD())], ['跃迁至距该成员', warpToMenu((d) => H.warpTo(wu, d))]);
    if (myRole() === 'fc') out.push(...warpItems(wu, true));
  } else if (['warp', 'align', 'loc'].includes(ev.k) && (ev.cel != null || iu)) {
    const tgt = ev.cel != null ? { cel: ev.cel } : iu;
    const w = unitWord(), f = formName();
    out.push(['跃迁至该处', () => H.warpTo(tgt, H.warpD())], ['跃迁至', warpToMenu((d) => H.warpTo(tgt, d))], ['朝向该处', () => H.alignTo(tgt)]);
    if (w) out.push([`带领${w}(${f})跃迁至地点`, () => fleetWarp(tgt)], [`带领${w}(${f})跃迁至距地点`, warpToMenu((d) => fleetWarp(tgt, d))]);
  } else if (['target', 'heal', 'armor', 'shield', 'cap'].includes(ev.k)) {
    const v = ev.k === 'target' || ev.k === 'heal' ? iu : wu;
    if (v && v !== S.me && v.alive && !S.me.pilot?.locks.has(v)) out.push(['锁定目标', () => H.lock(v)]);
  }
  if (out.length) out.push(null);
  if (isMember(ev.who)) out.push(['舰队成员', memberMenu(ev.who)], null);
  out.push(F.ignore.has(ev.k) ? ['显示这类广播信息', () => F.ignore.delete(ev.k)] : ['忽略这类广播信息', () => F.ignore.add(ev.k)]);
  return out;
}
// 单位菜单里追加的舰队条目（总览、扫描结果右键）：敌人 = 广播锁定；队友 = 维修目标、舰队 ▸（成员菜单）或邀请加入舰队
export function fleetMenu(v) {
  const S = H.S, F = S.fleet;
  if (!F || !fleetOn() || !v.alive) return [];
  const out = [], k = 'u' + v.i;
  if (v.side !== S.me.side) { if (inFleet()) out.push([BC.target[1], () => broadcast('target', { u: v })]); return out; }
  if (v === S.me) return out;
  if (isMember(k)) out.push([BC.heal[1], () => broadcast('heal', { u: v })], ['舰队', memberMenu(k)]);
  else if (!v.isDrone) out.push(['邀请加入舰队', inFleet() ? posMenu((dest) => join(k, dest)) : [['中队队员', () => { formFleet(); join(k); }]]]);
  return out;
}
export const isFleetMember = (v) => isMember('u' + v.i);

// ---------- 事件（pilot.js 的点击 / 右键 / 拖放里先问这里）----------
export function fleetClick(e) {
  const S = H.S, F = S.fleet;
  if (!F) return false;
  const t = e.target;
  let x;
  if ((x = t.closest('[data-fl-tab]'))) { F.tab = x.dataset.flTab; renderFleet(true); return true; }
  if ((x = t.closest('[data-fl-ctab]'))) { F.ctab = x.dataset.flCtab; renderFleet(true); return true; }
  if ((x = t.closest('[data-fl-formfleet]'))) { formFleet(); return true; }
  if ((x = t.closest('[data-fl-form]'))) { F.form = x.dataset.flForm; renderFleet(true); return true; }
  if ((x = t.closest('[data-fl-bc]'))) { broadcast(x.dataset.flBc); return true; }
  if ((x = t.closest('[data-fl-scope]'))) { setScope(SCOPE_NEXT[F.scope]); return true; }
  if ((x = t.closest('[data-fl-gear]'))) { H.menu(gearMenu(), e); return true; }
  if ((x = t.closest('[data-fl-arw]'))) { F.btns = !F.btns; renderFleet(true); return true; }
  if ((x = t.closest('[data-fl-clear]'))) {
    if (F.filter !== 'mem') { F.hist = []; F.last = null; }
    if (F.filter !== 'bc') F.mem = [];
    renderFleet(true);
    return true;
  }
  if (t.closest('[data-fl-rename]')) return true;
  // 最近广播条：Ctrl + 点击锁定广播的对象（客户端 OnLastBroadcastClick）
  if ((x = t.closest('[data-fl-ban]'))) { const u = F.last?.u != null ? S.b.units[F.last.u] : null; if (u && u !== S.me && (e.ctrlKey || e.metaKey)) H.lock(u); return true; }
  if ((x = t.closest('[data-fl-m], [data-fl-w]'))) { const u = unitByKey(x.dataset.flM || x.dataset.flW); if (u) H.pick(u.i, e); return true; }
  // 点标题：展开 / 收起（舰队那一级不能收）
  if ((x = t.closest('.pl-fl-h[data-fl-h]'))) { const id = x.dataset.flH; if (id !== 'f') { if (F.shut.has(id)) F.shut.delete(id); else F.shut.add(id); renderFleet(true); } return true; }
  return false;
}
export function fleetChange(e) {
  const F = H.S.fleet;
  let x;
  if ((x = e.target.closest?.('[data-fl-filter]'))) { F.filter = x.value; renderFleet(true); return true; }
  if ((x = e.target.closest?.('[data-fl-rename]'))) {
    const id = x.dataset.flRename, name = x.value.trim().slice(0, 10) || null;
    const g = id[0] === 'w' ? findWing(Number(id.slice(1))) : findSquad(Number(id.slice(1)))?.s;
    if (g) g.name = name;
    F.edit = null;
    x.blur();
    renderFleet(true);
    return true;
  }
  return false;
}
// 改名框：回车确定、Esc 取消
export function fleetInputKey(e) {
  const x = e.target.closest?.('[data-fl-rename]');
  if (!x) return false;
  if (e.key === 'Enter') { x.dispatchEvent(new Event('change', { bubbles: true })); return true; }
  if (e.key === 'Escape') { H.S.fleet.edit = null; x.blur(); renderFleet(true); return true; }
  return false;
}
// 右键：成员 / 关注列表行 / 编制表 → 成员菜单；标题 → 标题菜单；广播条、历史行 → 广播菜单
export function fleetCtx(e) {
  const S = H.S, F = S.fleet;
  if (!F) return false;
  const t = e.target;
  let x, items;
  if ((x = t.closest('[data-fl-m], [data-fl-w]'))) items = memberRowMenu(x.dataset.flM || x.dataset.flW);
  else if ((x = t.closest('[data-fl-h]'))) items = x.dataset.flH ? headerMenu(x.dataset.flH) : [];
  else if ((x = t.closest('[data-fl-ev]'))) items = bcMenu(F.hist[Number(x.dataset.flEv)]);
  else if (t.closest('[data-fl-ban]')) items = bcMenu(F.last);
  else if (t.closest('[data-win="fleet"] .pl-wh')) items = moreMenu();
  else return false;
  e.preventDefault();
  if (items.length) H.menu(items, e);
  return true;
}
// 拖放：成员拖到关注列表 = 关注；拖到标题 = 当这一级的指挥官（位置空着）或进这个中队；拖到队员身上 = 进他的中队
export function fleetDragStart(e) {
  const x = e.target.closest?.('[data-fl-m]');
  if (!x) return false;
  e.dataTransfer.setData('text/x-pl-fleet', x.dataset.flM);
  e.dataTransfer.effectAllowed = 'copyMove';
  return true;
}
function dropDest(e, k) {
  const F = H.S.fleet;
  const h = e.target.closest?.('[data-win="fleet"] [data-fl-h]'), m = e.target.closest?.('[data-win="fleet"] .pl-fl-m[data-fl-m]');
  if (h?.dataset.flH) {
    const id = h.dataset.flH;
    if (id === 'f') return F.fc ? null : { r: 'fc' };
    if (id[0] === 'w') { const w = findWing(Number(id.slice(1))); return w && !w.cmd ? { r: 'wc', w } : null; }
    const g = findSquad(Number(id.slice(1)));
    return g ? (g.s.cmd ? { r: 'sm', s: g.s } : { r: 'sc', s: g.s }) : null;
  }
  if (m && m.dataset.flM !== k) { const p = posOf(m.dataset.flM); return p.s ? { r: 'sm', s: p.s } : null; }
  return null;
}
export function fleetDragOver(e) {
  if (!e.dataTransfer.types.includes('text/x-pl-fleet')) return false;
  if (e.target.closest?.('[data-win="watch"]')) { e.preventDefault(); return true; }
  if (e.target.closest?.('[data-win="fleet"] [data-fl-h], [data-win="fleet"] .pl-fl-m') && inFleet() && cmdrOrBoss()) { e.preventDefault(); return true; }
  return false;
}
export function fleetDrop(e) {
  const k = e.dataTransfer.getData('text/x-pl-fleet');
  if (!k) return false;
  if (e.target.closest?.('[data-win="watch"]')) {
    const u = unitByKey(k);
    if (!u) return false;
    e.preventDefault();
    if (u !== H.S.me) watchAdd(u, true);
    return true;
  }
  if (!e.target.closest?.('[data-win="fleet"]') || !canMove(k)) return false;
  e.preventDefault();
  const dest = dropDest(e, k);
  if (dest) place(k, dest);
  return true;
}
