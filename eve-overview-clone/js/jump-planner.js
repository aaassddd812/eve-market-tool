// ===== 旗舰跳跃规划 =====
// 舰船参数取自 ESI 舰船属性（dogma）：867 基础跳跃距离（光年）、868 每光年燃料、866 燃料种类、1971 跳跃疲劳系数
// 坐标来自 map-data.json（单位 1e15 米）；1 光年 = 9.4607304725808e15 米
// 跳跃疲劳按 CCP 公布的规则估算：
//   跳后疲劳 = max(跳前疲劳, 10 分钟) × (1 + 有效光年)，上限 5 小时
//   重新激活冷却 = max(跳前疲劳 ÷ 10, 1 + 有效光年) 分钟，上限 30 分钟
//   有效光年 = 实际光年 × 疲劳系数；疲劳随时间每分钟减少 1 分钟

import { SERVER, serverKey } from './server.js?v=s3';

export const LY = 9.4607304725808;
const RANGE_MARGIN = 0.002;              // 坐标保留 2 位小数，留出误差余量，宁可少算一个边缘星系
const FATIGUE_CAP = 300;                 // 分钟
const COOLDOWN_CAP = 30;                 // 分钟
const JF_GROUP = 902;
const JF_SKILL_BONUS = 0.1;              // 战略货舰操作：每级跳跃燃料需求 -10%
const NO_JUMP_REGIONS = new Set([10000070, 10001000, 10000004, 10000017, 10000019]); // 波赫文、雅斯纳·扎赫、乔维星域
const NO_JUMP_REASON = { 10000070: '波赫文', 10001000: '扎尔扎克', 10000004: '乔维星域', 10000017: '乔维星域', 10000019: '乔维星域' };

// 可跳跃的舰船分组（顺序即下拉框顺序）
export const SHIP_GROUPS = [
  [547, '航空母舰'], [485, '无畏舰'], [4594, '枪骑兵级无畏舰'], [1538, '战力辅助舰'],
  [659, '超级航母'], [30, '泰坦'], [898, '黑隐特勤舰'], [902, '战略货舰'], [883, '旗舰级工业舰']
];

const SHIP_CACHE_KEY = 'eve-jump-ships-v1';
const STRUCTURE_CACHE_KEY = serverKey('eve-public-structures-v1');
const ESI_BASE = SERVER.esi;
const DS = 'datasource=' + SERVER.datasource;
const SHARED_STRUCTURES = '/api/esi/structures' + (SERVER.id === 'tq' ? '' : '?server=' + SERVER.id);   // 服务器共享缓存按服务器分开
export const STRUCTURE_SCOPE = 'esi-universe.read_structures.v1';
export const STRUCTURE_SEARCH_SCOPE = 'esi-search.search_structures.v1';

// 角色建筑搜索关键词：ESI 要求至少 3 个字符。玩家建筑名称固定为「星系名 - 自定义名」，
// 用「星系名最后一个字符 + 空格 - 空格」枚举（如「A - 」）即可覆盖几乎所有建筑；
// 单个关键词结果达到上限时，再向前多取一个字符细分（如「1A - 」）。
const SEARCH_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const SEARCH_CAP = 500;                   // ESI 搜索每个分类最多返回的条数
const PRIVATE_VERSION = 2;                // 私有建筑发现逻辑版本，变化后自动重新发现

// ---------- 停靠规则 ----------
// 舰船停靠等级：战略货舰虽需旗舰操作技能，但不算旗舰，可停靠中型建筑
const DOCK_CLASS = { 547: 'capital', 485: 'capital', 4594: 'capital', 1538: 'capital', 883: 'rorqual', 659: 'super', 30: 'super', 902: 'freighter', 898: 'subcap' };
const ALL = ['subcap', 'freighter', 'capital', 'rorqual', 'super'];
// NPC 空间站：超级航母、泰坦不能停靠
export const NPC_DOCK = new Set(['subcap', 'freighter', 'capital', 'rorqual']);
// 玩家建筑：中型只停非旗舰；大型可停旗舰；塔塔拉另可停长须鲸；只有星城可停超旗
export const STRUCTURES = {
  35832: ['空堡', ['subcap', 'freighter']],
  35825: ['莱塔卢', ['subcap', 'freighter']],
  35835: ['阿塔诺', ['subcap', 'freighter']],
  35836: ['塔塔拉', ['subcap', 'freighter', 'rorqual']],
  35833: ['铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  47512: ['"莫罗"铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  47513: ['"德拉库斯"铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  47514: ['"地平线"铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  47515: ['"马金尼斯"铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  47516: ['"普罗米修斯"铁壁', ['subcap', 'freighter', 'capital', 'rorqual']],
  35826: ['阿兹贝尔', ['subcap', 'freighter', 'capital', 'rorqual']],
  35827: ['索迪约', ['subcap', 'freighter', 'capital', 'rorqual']],
  35834: ['星城', ALL],
  40340: ['昇威豪华星城', ALL]
};

export const shipDockClass = (ship) => DOCK_CLASS[ship.group] || 'capital';
export const canDockStructure = (ship, typeId) => Boolean(STRUCTURES[typeId]?.[1].includes(shipDockClass(ship)));
export const canDockNpc = (ship) => NPC_DOCK.has(shipDockClass(ship));

export function hasStructureScope(token) {
  if (!token?.scopes) return null;                 // 旧令牌没有记录授权范围：未知，读取时再判断
  const list = Array.isArray(token.scopes) ? token.scopes : String(token.scopes).split(/\s+/);
  return list.includes(STRUCTURE_SCOPE);
}

export function hasStructureSearchScope(token) {
  if (!token?.scopes) return false;                // 没有搜索权限时用订单/合同位置兜底
  const list = Array.isArray(token.scopes) ? token.scopes : String(token.scopes).split(/\s+/);
  return list.includes(STRUCTURE_SEARCH_SCOPE);
}

export function cachedStructures() {
  try {
    const c = JSON.parse(localStorage.getItem(STRUCTURE_CACHE_KEY) || 'null');
    if (c && Date.now() - c.at < 86400e3 && Array.isArray(c.list)) return c;
  } catch { /* 忽略 */ }
  return null;
}

// 服务器共享缓存只存公开建筑；军团/联盟内部建筑属于私有信息，只留在各自浏览器
let structuresPosted = false;
function shareToServer(result) {
  if (structuresPosted) return;
  structuresPosted = true;
  try {
    fetch(SHARED_STRUCTURES, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: result.at, list: result.list, total: result.total, denied: result.denied || 0 })
    }).catch(() => {});
  } catch { /* 忽略 */ }
}

async function fetchStructureInfo(id, token) {
  const r = await fetch(`${ESI_BASE}/universe/structures/${id}/?${DS}`, { headers: { Authorization: 'Bearer ' + token.access_token } }).catch(() => null);
  if (!r?.ok) return null;                          // 403 = 没有停靠权限，跳过
  const info = await r.json().catch(() => null);
  if (!info || !STRUCTURES[info.type_id]) return null;
  return { id, name: info.name, system: info.solar_system_id, type: info.type_id };
}

/**
 * 发现“当前角色有停靠权限”的建筑（含军团/联盟内部建筑，公开列表里没有）：
 * 1. 角色建筑搜索（esi-search.search_structures.v1）按前缀枚举，覆盖最全；
 * 2. 无搜索权限时从市场订单、合同起讫位置和当前停靠位置兜底（这些 scope 都是绑定即有的）。
 * 搜索失败、没有权限或令牌不支持都不会中断，只是结果少一些。
 */
async function discoverPrivateStructures(getToken, knownIds, onProgress = () => {}) {
  const token = await getToken();
  const candidates = new Set();
  const add = (id) => { if (id >= 1e12 && !knownIds.has(id)) candidates.add(id); };
  const searched = hasStructureSearchScope(token);
  if (searched) {
    const queue = SEARCH_CHARS.map((c) => c + ' - ');
    let done = 0;
    async function searchWorker() {
      while (queue.length) {
        const term = queue.shift();
        const r = await fetch(`${ESI_BASE}/characters/${token.character_id}/search/?categories=structure&search=${encodeURIComponent(term)}&${DS}`, { headers: { Authorization: 'Bearer ' + token.access_token } }).catch(() => null);
        if (r?.ok) {
          const ids = (await r.json().catch(() => ({}))).structure || [];
          ids.forEach(add);
          // 结果达到上限：可能有遗漏，按前一个字符继续细分（最多细分到 3 个字符的前缀）
          if (ids.length >= SEARCH_CAP && term.length < 7) queue.push(...SEARCH_CHARS.map((c) => c + term));
        }
        onProgress(++done, done + queue.length);
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    await Promise.all(Array.from({ length: 4 }, searchWorker));
  }
  // 兜底与补充：订单、合同、资产、克隆、工业任务所在的建筑，以及当前停靠位置
  try {
    const auth = { headers: { Authorization: 'Bearer ' + token.access_token } };
    const cid = token.character_id;
    const get = (path, fallback) => fetch(`${ESI_BASE}/characters/${cid}/${path}${path.includes('?') ? '&' : '?'}${DS}`, auth)
      .then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
    const [orders, contracts, location, clones, jobs, assets] = await Promise.all([
      get('orders/', []), get('contracts/', []), get('location/', {}), get('clones/', {}), get('industry/jobs/', []), get('assets/?page=1', [])
    ]);
    orders.forEach((o) => add(o.location_id));
    contracts.forEach((c) => { add(c.start_location_id); add(c.end_location_id); });
    add(location.structure_id);
    if (clones.home_location?.location_type === 'structure') add(clones.home_location.location_id);
    (clones.jump_clones || []).forEach((c) => { if (c.location_type === 'structure') add(c.location_id); });
    jobs.forEach((j) => { add(j.facility_id); add(j.station_id); });
    // 资产：只取直接放在机库里的物品（容器、舰船里的物品 location_id 是物品 ID，不是建筑）
    if (Array.isArray(assets)) {
      const itemIds = new Set(assets.map((a) => a.item_id));
      assets.forEach((a) => { if (a.location_flag === 'Hangar' && !itemIds.has(a.location_id)) add(a.location_id); });
    }
  } catch { /* 兜底失败不影响主流程 */ }
  const extra = [];
  const ids = [...candidates];
  let cursor = 0;
  async function detailWorker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const st = await fetchStructureInfo(id, token);
      if (st) extra.push(st);
    }
  }
  await Promise.all(Array.from({ length: 4 }, detailWorker));
  return { list: extra, searched };
}

// 私有建筑结果写入缓存对象（带版本与是否使用了建筑搜索，授权变化后会自动重新发现）
async function attachPrivate(target, getToken, onProgress) {
  const found = await discoverPrivateStructures(getToken, new Set(target.list.map((s) => s.id)), onProgress);
  target.private = found.list;
  target.privateSearched = found.searched;
  target.privateVersion = PRIVATE_VERSION;
}

/**
 * 读取玩家建筑：公开列表（/universe/structures/ 约千个）+ 当前角色可停靠的私有建筑。
 * 读取顺序：本地缓存 → 服务器共享缓存（其他浏览器回传的公开部分）→ 直接读 ESI。
 * 详情接口需要 esi-universe.read_structures.v1；无权查看的建筑（403）视为无法停靠。
 * 遵守 ESI 错误限额：剩余额度过低时暂停到重置，避免被临时封禁。结果在本地缓存 24 小时，
 * 公开部分回传服务器，之后的浏览器秒读。
 */
export async function loadPublicStructures(getToken, onProgress = () => {}) {
  const hit = cachedStructures();
  if (hit) {
    // 公开部分仍有效时不重读；私有部分在旧版本、或之前没有搜索权限而现在有时重新发现
    const token = await getToken().catch(() => null);
    if (!Array.isArray(hit.private) || hit.privateVersion !== PRIVATE_VERSION || (!hit.privateSearched && hasStructureSearchScope(token))) {
      try {
        await attachPrivate(hit, getToken, (d, t) => onProgress(d, t, 'private'));
        try { localStorage.setItem(STRUCTURE_CACHE_KEY, JSON.stringify(hit)); } catch { /* 忽略 */ }
      } catch { hit.private = hit.private || []; }
    }
    shareToServer(hit);
    return hit;
  }
  let publicList = null, total = 0, denied = 0, at = Date.now();
  try {
    const r = await fetch(SHARED_STRUCTURES);
    if (r.ok) {
      const c = await r.json();
      if (c && Date.now() - c.at < 86400e3 && Array.isArray(c.list) && c.list.length) {
        publicList = c.list; total = c.total || c.list.length; denied = c.denied || 0; at = c.at;
      }
    }
  } catch { /* 服务器不可用时照旧直接读 ESI */ }
  if (!publicList) {
    const res = await fetch(ESI_BASE + '/universe/structures/?' + DS);
    if (!res.ok) throw new Error('公开建筑列表读取失败 ESI ' + res.status);
    const ids = await res.json();
    const list = [];
    let done = 0, pauseUntil = 0, unauthorized = 0;
    const queue = [...ids];
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        const wait = pauseUntil - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const token = await getToken();
        const r = await fetch(`${ESI_BASE}/universe/structures/${id}/?${DS}`, { headers: { Authorization: 'Bearer ' + token.access_token } }).catch(() => null);
        const remain = Number(r?.headers.get('x-esi-error-limit-remain'));
        if (Number.isFinite(remain) && r.headers.get('x-esi-error-limit-remain') !== null && remain < 20) {
          pauseUntil = Date.now() + (Number(r.headers.get('x-esi-error-limit-reset')) || 60) * 1000;
        }
        if (r?.ok) {
          const info = await r.json();
          if (STRUCTURES[info.type_id]) list.push({ id, name: info.name, system: info.solar_system_id, type: info.type_id });
        } else if (r?.status === 401 || r?.status === 403) {
          // 403 可能是这个建筑不对你开放，也可能是令牌缺少授权范围；后者立即停止，不再消耗错误额度
          const body = await r.json().catch(() => ({}));
          if (r.status === 401 || /scope/i.test(body.error || '')) unauthorized += 1;
          else denied += 1;
          if (unauthorized >= 3) { queue.length = 0; break; }
        } else {
          denied += 1;
        }
        done += 1;
        onProgress(done, ids.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    if (unauthorized >= 3 && !list.length) throw new Error('当前授权没有读取玩家建筑的权限，请重新绑定 ESI');
    publicList = list; total = ids.length;
  }
  const result = { at, list: publicList, private: [], total, denied };
  try { await attachPrivate(result, getToken, (d, t) => onProgress(d, t, 'private')); } catch { /* 私有建筑发现失败不影响公开列表 */ }
  try { localStorage.setItem(STRUCTURE_CACHE_KEY, JSON.stringify(result)); } catch { /* 忽略 */ }
  shareToServer(result);
  return result;
}

// 读取全部可跳跃舰船的跳跃参数（首次约 70 个 ESI 请求，结果缓存在本地）
export async function loadJumpShips(fetchESI) {
  try {
    const cached = JSON.parse(localStorage.getItem(SHIP_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.at < 7 * 86400e3 && cached.ships?.length) return cached.ships;
  } catch { /* 本地存储不可用时直接请求 */ }
  const groups = await Promise.all(SHIP_GROUPS.map(([id]) => fetchESI(`/universe/groups/${id}/`).catch(() => ({ types: [] }))));
  const ids = groups.flatMap((g, gi) => (g.types || []).map((t) => [t, SHIP_GROUPS[gi][0]]));
  const ships = (await Promise.all(ids.map(async ([typeId, group]) => {
    try {
      const t = await fetchESI(`/universe/types/${typeId}/?language=zh`);
      if (!t.published) return null;
      const a = Object.fromEntries((t.dogma_attributes || []).map((x) => [x.attribute_id, x.value]));
      if (!a[867]) return null;
      return { id: typeId, name: t.name, group, range: a[867], fuel: a[868] || 0, fuelType: a[866] || 0, fatigue: a[1971] || 1 };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  const order = new Map(SHIP_GROUPS.map(([id], i) => [id, i]));
  ships.sort((a, b) => order.get(a.group) - order.get(b.group) || a.name.localeCompare(b.name, 'zh-CN'));
  try { localStorage.setItem(SHIP_CACHE_KEY, JSON.stringify({ at: Date.now(), ships })); } catch { /* 忽略 */ }
  return ships;
}

export function maxRange(ship, jdc) {
  return ship.range * (1 + 0.2 * jdc);   // 跳跃引擎校准理论：每级 +20%
}

export function fuelPerLy(ship, jfc, jfSkill) {
  let f = ship.fuel * (1 - 0.1 * jfc);  // 跳跃燃料节约：每级 -10%
  if (ship.group === JF_GROUP) f *= 1 - JF_SKILL_BONUS * jfSkill;
  return f;
}

const secDisplay = (sec) => (sec > 0 && sec < 0.05 ? 0.1 : Math.max(0, Math.round(sec * 10) / 10));
export const isHighSec = (s) => secDisplay(s.sec) >= 0.5;
export const canJumpInto = (s) => !isHighSec(s) && !NO_JUMP_REGIONS.has(s.region);
export const canJumpFrom = (s) => !NO_JUMP_REGIONS.has(s.region);

export function lyBetween(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / LY;
}

// 一跳可达的星系
export function inRange(systems, origin, range) {
  const out = [];
  for (const s of systems) if (s !== origin && canJumpInto(s) && lyBetween(origin, s) <= range - RANGE_MARGIN) out.push(s.i);
  return out;
}

// 二叉堆（按 cost 升序）
class Heap {
  constructor() { this.a = []; }
  push(item) {
    const a = this.a; a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// 星门跳数（广度优先），用于终点在高安时找最近的可跳入星系
function gateHops(systems, from, limit) {
  const hops = new Int16Array(systems.length).fill(-1);
  const prev = new Int32Array(systems.length).fill(-1);
  hops[from] = 0;
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (hops[cur] >= limit) continue;
    for (const n of systems[cur].nbr) if (hops[n] < 0) { hops[n] = hops[cur] + 1; prev[n] = cur; queue.push(n); }
  }
  return { hops, prev };
}

/**
 * 规划跳跃路线：先最少跳跃次数，再最短总光年。
 * options: { range, stops（中途必须停靠的星系 Set<index>，null 表示不限）,
 *            prefer（中途优先停靠的星系 Set<index>：先让无法停靠的中途点最少，再比跳跃次数和光年）, avoid: Set<index> }
 * 终点不能跳入（高安等）时，先跳到离终点星门数最少的可跳入星系，再走星门。
 */
const NO_DOCK_PENALTY = 1e6;               // 每个无法停靠的中途点的代价，远大于任何跳跃次数差

export function planJumpRoute(systems, from, to, { range, stops = null, prefer = null, avoid = new Set() }) {
  const origin = systems[from], dest = systems[to];
  if (!canJumpFrom(origin)) return { error: `${origin.name} 位于${NO_JUMP_REASON[origin.region]}，无法使用跳跃引擎` };
  if (NO_JUMP_REGIONS.has(dest.region)) return { error: `${dest.name} 位于${NO_JUMP_REASON[dest.region]}，跳跃引擎无法进入` };
  if (from === to) return { error: '起点和终点相同' };

  // 候选落点：终点本身，或（终点不能跳入时）星门 15 跳以内的可跳入星系
  const targets = new Map();      // index → 落点后还需的星门数
  let gate = null;
  if (canJumpInto(dest) && !avoid.has(to)) targets.set(to, 0);
  else {
    gate = gateHops(systems, to, 15);
    systems.forEach((s, i) => { if (gate.hops[i] > 0 && canJumpInto(s) && !avoid.has(i)) targets.set(i, gate.hops[i]); });
    if (!targets.size) return { error: `${dest.name} 附近 15 个星门内没有可跳入的星系` };
  }

  // Dijkstra：cost = 无法停靠的中途点 × 1e6 + 跳跃次数 × 1000 + 总光年
  const n = systems.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  best[from] = 0;
  heap.push({ i: from, cost: 0 });
  const limit = range - RANGE_MARGIN;
  const nodes = systems.filter((s) => canJumpInto(s) && !avoid.has(s.i));
  while (heap.size) {
    const { i, cost } = heap.pop();
    if (cost > best[i]) continue;
    if (targets.has(i) && i !== from) continue;   // 落点不再向外扩展
    const a = systems[i];
    for (const b of nodes) {
      if (b.i === i) continue;
      if (stops && !stops.has(b.i) && !targets.has(b.i)) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const ly = Math.sqrt(d2) / LY;
      if (ly > limit) continue;
      const c = cost + 1000 + ly + (prefer && !prefer.has(b.i) && !targets.has(b.i) ? NO_DOCK_PENALTY : 0);
      if (c < best[b.i]) { best[b.i] = c; prev[b.i] = i; heap.push({ i: b.i, cost: c }); }
    }
  }

  // 选落点：星门数最少，其次跳跃次数，再次总光年
  let pick = -1, pickGates = Infinity;
  for (const [i, gates] of targets) {
    if (!Number.isFinite(best[i])) continue;
    if (gates < pickGates || (gates === pickGates && best[i] < best[pick])) { pick = i; pickGates = gates; }
  }
  if (pick < 0) return { error: `在当前跳跃距离（${range.toFixed(2)} 光年）内无法到达${stops ? '（已限制中途必须可停靠，可尝试放宽停靠要求）' : ''}` };

  const path = [];
  for (let i = pick; i >= 0; i = prev[i]) path.push(i);
  path.reverse();
  const legs = [];
  for (let k = 1; k < path.length; k++) legs.push({ from: path[k - 1], to: path[k], ly: lyBetween(systems[path[k - 1]], systems[path[k]]) });

  // 落点之后的星门路线（沿广度优先树回溯到终点）
  const gates = [];
  if (pick !== to && gate) {
    for (let i = pick; i !== to && i >= 0; i = gate.prev[i]) gates.push(gate.prev[i]);
  }
  return { path, legs, gates, landing: pick };
}

// 逐跳估算燃料、冷却与疲劳（每次冷却结束立即起跳）
// fatigue：第一跳之前已有的疲劳（分钟，读自角色 ESI），默认 0
export function simulate(legs, ship, { jfc, jfSkill, fatigue: start = 0 }) {
  const perLy = fuelPerLy(ship, jfc, jfSkill);
  let fatigue = Math.min(FATIGUE_CAP, Math.max(0, start)), elapsed = 0, fuel = 0;
  const rows = legs.map((leg, k) => {
    const eff = leg.ly * ship.fatigue;
    const cooldown = Math.min(COOLDOWN_CAP, Math.max(fatigue / 10, 1 + eff));
    fatigue = Math.min(FATIGUE_CAP, Math.max(fatigue, 10) * (1 + eff));
    const legFuel = Math.ceil(leg.ly * perLy);
    fuel += legFuel;
    const row = { ...leg, fuel: legFuel, cooldown, fatigue, depart: elapsed };
    if (k < legs.length - 1) {
      elapsed += cooldown;
      fatigue = Math.max(0, fatigue - cooldown);   // 等待冷却期间疲劳同步衰减
    }
    return row;
  });
  const last = rows[rows.length - 1];
  return { rows, fuel, totalLy: legs.reduce((s, l) => s + l.ly, 0), travel: elapsed, finalFatigue: last?.fatigue || 0, finalCooldown: last?.cooldown || 0 };
}

export function formatMinutes(min) {
  if (min < 1) return '不到 1 分钟';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} 小时${m ? ' ' + m + ' 分' : ''}` : `${m} 分钟`;
}
