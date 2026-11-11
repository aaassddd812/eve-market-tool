// 共用数据：物品中文名（本站 type-names-zh.json）、英文名对照（本站 i18n/names-en.json，粘贴英文客户端的货柜时才加载）、
// ESI 名称解析（星系、空间站、角色、军团…）、价格（宁静服：本站 /api/v1/prices 每小时汇总的吉他最低卖 / 最高收；
// 国服：ESI 全服均价，估战利品时逐个物品查交易中心挂单）
import { http, store } from './platform.js';
import { SERVER, SITE } from './servers.js';
import { esiPublic, esiPost, esiAuth } from './esi.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function formatISK(v) {
  const n = Number(v) || 0, a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
export const formatNumber = (v) => (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const formatPrice = (v) => (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtTime = (t, withSec) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}) });
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${String(sec).padStart(2, '0')} 秒` : `${sec} 秒`;
}

// ---------- 物品名称 ----------
let zhNames = null;   // Map id -> 中文名
let namesP = null;
export function loadTypeNames() {
  namesP ||= (async () => {
    const res = await http(SITE + '/type-names-zh.json');
    if (!res.ok) throw new Error('读取物品名称失败（HTTP ' + res.status + '）');
    const obj = await res.json();
    zhNames = new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
    return zhNames;
  })().catch((e) => { namesP = null; throw e; });
  return namesP;
}
const extraNames = new Map(store.get('lite-names', []));   // ESI 解析过的名称（星系、空间站、非市场物品…），存在本机
export function typeName(id) { return zhNames?.get(Number(id)) || extraNames.get(Number(id)) || '物品 ' + id; }
export const findTypes = (pred) => (zhNames ? [...zhNames].filter(([, n]) => pred(n)) : []);
export const nameOf = (id) => zhNames?.get(Number(id)) || extraNames.get(Number(id)) || null;

// ESI /universe/names/：一次最多 1000 个；查不到的（玩家建筑等）跳过
export async function resolveNames(ids) {
  const want = [...new Set(ids.map(Number))].filter((id) => id > 0 && id < 2 ** 31 && !nameOf(id));
  for (let i = 0; i < want.length; i += 1000) {
    const batch = want.slice(i, i + 1000);
    try {
      for (const r of await esiPost('/universe/names/?language=zh', batch)) extraNames.set(r.id, r.name);
    } catch {
      // 一批里有无效 ID 时整批 404：拆成单个再查
      await Promise.all(batch.map(async (id) => { try { const [r] = await esiPost('/universe/names/?language=zh', [id]); if (r) extraNames.set(r.id, r.name); } catch { /* 跳过 */ } }));
    }
  }
  if (want.length) store.set('lite-names', [...extraNames].slice(-5000));
}
// 玩家建筑名称（需要 esi-universe.read_structures.v1，且角色有停靠权限）
export async function structureName(acc, id) {
  if (nameOf(id)) return nameOf(id);
  try { const s = await esiAuth(acc, '/universe/structures/' + id + '/'); extraNames.set(Number(id), s.name); store.set('lite-names', [...extraNames].slice(-5000)); return s.name; } catch { return null; }
}

// 英文对照（中文名 → 英文名，本站 i18n/names-en.json，约 4MB）：粘贴英文货柜、英文客户端的本地频道名时才加载
let zh2enP = null;
const loadZh2En = () => (zh2enP ||= http(SITE + '/i18n/names-en.json').then((r) => r.json()).catch(() => { zh2enP = null; return {}; }));

// 已知星系名（本站星图 map-data.json 的中文名 + 英文名）：聊天日志里本地频道名不是已知星系 = 在深渊里
let sysZh = null, sysEn = null, sysRaw = [];
export async function knownSystem(name) {
  if (!sysZh) {
    // 星图读不到时不判断（当作已知星系），免得把每个频道都当成深渊
    const m = await http(SITE + '/map-data.json').then((r) => r.json()).catch(() => null);
    if (!Array.isArray(m?.systems)) return true;
    sysRaw = m.systems.map((x) => String(x[1]));
    sysZh = new Set(sysRaw.map((x) => x.toLowerCase()));
  }
  const key = String(name).trim().toLowerCase();
  if (sysZh.has(key)) return true;
  if (!/[a-z]/i.test(key)) return false;
  if (!sysEn) {
    const zh2en = await loadZh2En();
    sysEn = new Set(sysRaw.map((z) => String(zh2en[z] || '').toLowerCase()).filter(Boolean));
  }
  return sysEn.has(key);
}

// 粘贴货柜用：名称 → ID（中文名；含英文字母时再加载英文对照）
let byName = null, byEn = null;
export async function lookupName(name) {
  await loadTypeNames();
  if (!byName) { byName = new Map(); for (const [id, n] of zhNames) byName.set(n.toLowerCase(), id); }
  const key = name.trim().toLowerCase();
  if (byName.has(key)) return byName.get(key);
  if (!/[a-z]/i.test(key)) return null;
  if (!byEn) {
    byEn = new Map();
    const zh2en = await loadZh2En();
    for (const [zh, en] of Object.entries(zh2en)) { const id = byName.get(zh.toLowerCase()); if (id) byEn.set(String(en).toLowerCase(), id); }
  }
  return byEn.get(key) || null;
}

// ---------- 价格 ----------
const priceCache = new Map();   // id -> { sell, buy, at }
const PRICE_TTL = 30 * 60e3;
let avgP = null;
function avgPrices() {
  avgP ||= esiPublic('/markets/prices/').then((list) => new Map(list.map((p) => [p.type_id, p.average_price || p.adjusted_price || 0]))).catch((e) => { avgP = null; throw e; });
  return avgP;
}
// 宁静服：本站汇总接口一次 200 个；国服：exact=true 时逐个查交易中心星域挂单（战利品），否则用全服均价（资产估值）
export async function getPrices(ids, { exact = false } = {}) {
  const todo = [...new Set(ids.map(Number))].filter((id) => id > 0 && !(Date.now() - (priceCache.get(id)?.at || 0) < PRICE_TTL));
  if (todo.length && SERVER.sitePrices) {
    for (let i = 0; i < todo.length; i += 200) {
      const batch = todo.slice(i, i + 200);
      const res = await http(`${SITE}/api/v1/prices?types=${batch.join(',')}&hub=${SERVER.hub.region}`);
      if (!res.ok) throw new Error('读取价格失败（HTTP ' + res.status + '）');
      const data = await res.json();
      for (const id of batch) { const p = data.types?.[id] || {}; priceCache.set(id, { sell: p.sell ?? null, buy: p.buy ?? null, at: Date.now() }); }
    }
  } else if (todo.length) {
    const avg = await avgPrices();
    if (exact && todo.length <= 80) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < todo.length) {
          const id = todo[cursor++];
          try {
            const orders = await esiPublic(`/markets/${SERVER.hub.region}/orders/?order_type=all&type_id=${id}`);
            const sells = orders.filter((o) => !o.is_buy_order).map((o) => o.price), buys = orders.filter((o) => o.is_buy_order).map((o) => o.price);
            priceCache.set(id, { sell: sells.length ? Math.min(...sells) : null, buy: buys.length ? Math.max(...buys) : null, at: Date.now() });
          } catch { priceCache.set(id, { sell: avg.get(id) || null, buy: avg.get(id) || null, at: Date.now() }); }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    } else {
      for (const id of todo) { const v = avg.get(id) || null; priceCache.set(id, { sell: v, buy: v, at: Date.now() }); }
    }
  }
  return new Map(ids.map((id) => [Number(id), priceCache.get(Number(id)) || { sell: null, buy: null }]));
}
export const priceOf = (map, id, side = 'sell') => { const p = map.get(Number(id)); return (side === 'buy' ? p?.buy ?? p?.sell : p?.sell ?? p?.buy) || 0; };

// 深渊星系：ID 在 32000000 段（宁静与国服相同）
export const isAbyssSystem = (id) => id >= 32000000 && id < 33000000;
