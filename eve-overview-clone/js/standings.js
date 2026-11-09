// ===== 声望（已绑定角色的联系人）=====
// 跟游戏里总览的颜色一样：同军团绿星、同联盟蓝星，联系人声望 +10 深蓝、+5 浅蓝、-5 橙、-10 红，中立不标。
// 数据：角色自己的军团 / 联盟（公开 /characters/{id}/），以及三层联系人：
//   个人 /characters/{id}/contacts/（esi-characters.read_contacts.v1）、军团 /corporations/{id}/contacts/（esi-corporations.read_contacts.v1）、
//   联盟 /alliances/{id}/contacts/（esi-alliances.read_contacts.v1）；没有的权限那一层就跳过。
// 对一个玩家（角色 / 军团 / 联盟 ID）取声望：先个人、再军团、再联盟联系人；每层里角色优先于其军团、再其联盟（与游戏一致）。
// 归类（预警过滤用）：friend 友方（同军团 / 同联盟 / 正声望）、neutral 中立、hostile 敌对（负声望）。
// 缓存在 eve-standings-v1（按服务器，记角色 ID）30 分钟；ESI 联系人接口本身缓存 5 分钟。
// 只有角色名的地方（本地日志）用 idsByName + affiliation 补齐 ID（公开接口，不需要授权），结果在内存里缓存。

import { serverKey, esiUrl } from './server.js?v=s4';

let ctx;   // tokenInfo, hasScope, fetchPaged
const KEY = serverKey('eve-standings-v1');
const TTL = 30 * 60e3;
export const SCOPES = ['esi-characters.read_contacts.v1', 'esi-corporations.read_contacts.v1', 'esi-alliances.read_contacts.v1'];
const LEVELS = [['personal', SCOPES[0]], ['corp', SCOPES[1]], ['alliance', SCOPES[2]]];
const LEVEL_ZH = { personal: '个人', corp: '军团', alliance: '联盟' };
let D = null;   // { char, corp, alliance, at, lists: { personal: {id: standing}, corp: {...}, alliance: {...} } }
let loading = null;
const subs = new Set();

export function initStandings(context) {
  ctx = context;
  try { D = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { D = null; }
  refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
export function onStandings(fn) { subs.add(fn); }
const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

// 有没有可用的声望数据（当前绑定的角色）
const token = () => ctx?.tokenInfo();
// 当前绑定的角色、且授权里的联系人权限没变（重新绑定加了权限要重读）
const scopeKey = (t) => SCOPES.filter((s) => ctx.hasScope(t, s)).join();
const current = () => Boolean(D && token() && D.char === token().character_id && D.sc === scopeKey(token()));
export const ready = () => current();
// 已绑定但授权里一个联系人权限都没有：提示重新绑定
export const missingScope = () => Boolean(token()) && !SCOPES.some((s) => ctx.hasScope(token(), s));

// 重新读取（换了角色、过期、或 force）
export function refresh(force = false) {
  const t = token();
  if (!t) { if (D) { D = null; notify(); } return Promise.resolve(); }
  if (!force && current() && Date.now() - D.at < TTL) return Promise.resolve();
  if (loading) return loading;
  loading = load(t).catch((e) => console.warn('声望读取失败', e)).finally(() => { loading = null; });
  return loading;
}
async function load(t) {
  const me = await fetch(esiUrl(`/characters/${t.character_id}/`)).then((r) => (r.ok ? r.json() : Promise.reject(new Error('ESI ' + r.status))));
  const owner = { personal: t.character_id, corp: me.corporation_id, alliance: me.alliance_id };
  const path = { personal: 'characters', corp: 'corporations', alliance: 'alliances' };
  const lists = {};
  for (const [lv, scope] of LEVELS) {
    if (!owner[lv] || !ctx.hasScope(t, scope)) continue;
    try {
      const rows = await ctx.fetchPaged(`/${path[lv]}/${owner[lv]}/contacts/`, 10);
      lists[lv] = Object.fromEntries(rows.map((c) => [c.contact_id, c.standing]));
    } catch (e) { console.warn('联系人读取失败', lv, e); }
  }
  // 换了角色时以最新的为准
  if (token()?.character_id !== t.character_id) return;
  D = { char: t.character_id, sc: scopeKey(t), corp: me.corporation_id || 0, alliance: me.alliance_id || 0, at: Date.now(), lists };
  try { localStorage.setItem(KEY, JSON.stringify(D)); } catch { /* 忽略 */ }
  notify();
}

// 一个玩家的声望：ent = { char, corp, alliance }（都可选）；没有数据返回 null
// 返回 { cls: corp|alliance|excellent|good|neutral|bad|terrible, value, from }
export function of(ent) {
  if (!current() || !ent) return null;
  const { char, corp, alliance } = ent;
  if (char && char === D.char) return { cls: 'self', value: null, from: '' };
  if (corp && corp === D.corp) return { cls: 'corp', value: null, from: '' };
  if (alliance && alliance === D.alliance) return { cls: 'alliance', value: null, from: '' };
  for (const [lv] of LEVELS) {
    const list = D.lists[lv];
    if (!list) continue;
    for (const id of [char, corp, alliance]) {
      if (id && list[id] != null) {
        const v = list[id];
        return { cls: v > 5 ? 'excellent' : v > 0 ? 'good' : v < -5 ? 'terrible' : v < 0 ? 'bad' : 'neutral', value: v, from: LEVEL_ZH[lv] };
      }
    }
  }
  return { cls: 'neutral', value: 0, from: '' };
}
// 归类：friend / neutral / hostile；没有数据返回 null
export function group(ent) {
  const s = of(ent);
  if (!s) return null;
  return ['self', 'corp', 'alliance', 'excellent', 'good'].includes(s.cls) ? 'friend' : ['bad', 'terrible'].includes(s.cls) ? 'hostile' : 'neutral';
}
export const GROUPS = [['friend', '友方'], ['neutral', '中立'], ['hostile', '敌对']];

// 名字前的小标（中立、自己不标）
// 底色方块和符号画在同一个 SVG 里（字体里的 + − ★ 不居中，方块与符号分开排版也会因取整偏 1 像素）
const svgOf = (d) => `<svg viewBox="0 0 14 14" aria-hidden="true"><rect width="14" height="14" rx="3" fill="currentColor"/>${d}</svg>`;
const STAR = svgOf('<path d="M7 2.75l1.25 2.7 2.95.33-2.2 2 .62 2.92L7 9.2l-2.62 1.5L5 7.78l-2.2-2 2.95-.33z" fill="#fff"/>');
const PLUS = svgOf('<path d="M7 3.75v6.5M3.75 7h6.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/>');
const MINUS = svgOf('<path d="M3.75 7h6.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/>');
const SYM = { corp: STAR, alliance: STAR, excellent: PLUS, good: PLUS, bad: MINUS, terrible: MINUS };
const EQ = svgOf('<path d="M4 5.4h6M4 8.6h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>');
// 单独的声望图标（筛选按钮用）：cls 同 of().cls，中立是灰底等号
export const icon = (cls) => `<i class="st-badge st-${cls}" aria-hidden="true">${cls === 'neutral' ? EQ : SYM[cls] || ''}</i>`;
// 小标多在 translate="no" 的名字里，i18n.js 不翻译，这里直接按界面语言出文字
const EN = window.I18N?.lang === 'en';
const TIP = EN ? { corp: 'Same corporation', alliance: 'Same alliance', excellent: 'Excellent standing', good: 'Good standing', bad: 'Bad standing', terrible: 'Terrible standing' }
  : { corp: '同军团', alliance: '同联盟', excellent: '声望优秀', good: '声望良好', bad: '声望不良', terrible: '声望恶劣' };
const FROM_EN = { 个人: 'personal', 军团: 'corp', 联盟: 'alliance' };
export function badge(ent) {
  const s = of(ent);
  if (!s || !SYM[s.cls]) return '';
  const v = s.value != null ? `${s.value > 0 ? '+' : ''}${Number(s.value.toFixed(1))}` : '';
  const tip = TIP[s.cls] + (v ? (EN ? ` ${v} (${FROM_EN[s.from]} contact)` : ` ${v}（${s.from}联系人）`) : '');
  return `<i class="st-badge st-${s.cls}" title="${tip}" aria-label="${tip}">${SYM[s.cls]}</i>`;
}
// ---------- 只有角色名 / 角色 ID 时补齐军团、联盟（公开接口）----------
const aff = new Map();     // 角色 ID → { corp, alliance, at }
const nameIds = new Map(); // 小写名字 → 角色 ID（0 = 查不到）
const AFF_TTL = 60 * 60e3;
const tried = new Map();   // 'i' + 角色 ID / 'n' + 名字 → 上次查询时间
// 角色 ID 列表 → Map(角色 ID → { char, corp, alliance })
export async function affiliation(ids) {
  const now = Date.now();
  // 只查角色 ID（军团 98xxxxxx、联盟 99xxxxxx 混进来整批会被 ESI 拒绝）
  const need = [...new Set(ids.filter(Boolean).map(Number))].filter((id) => (id < 98e6 || id >= 2.1e9) && !(aff.get(id)?.at > now - AFF_TTL));
  for (let i = 0; i < need.length; i += 1000) {
    try {
      const res = await fetch(esiUrl('/characters/affiliation/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(need.slice(i, i + 1000)) });
      if (res.ok) for (const r of await res.json()) aff.set(r.character_id, { corp: r.corporation_id, alliance: r.alliance_id || 0, at: now });
    } catch { /* 下次再试 */ }
  }
  return new Map(ids.filter(Boolean).map(Number).map((id) => [id, { char: id, ...(aff.get(id) || {}) }]));
}
// 角色名列表 → Map(小写名字 → 角色 ID)
export async function idsByName(names) {
  const need = [...new Set(names.filter(Boolean).map((n) => n.trim()))].filter((n) => !nameIds.has(n.toLowerCase()));
  for (let i = 0; i < need.length; i += 500) {
    const part = need.slice(i, i + 500);
    try {
      const res = await fetch(esiUrl('/universe/ids/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(part) });
      const d = res.ok ? await res.json() : {};
      for (const c of d.characters || []) nameIds.set(c.name.toLowerCase(), c.id);
      for (const n of part) if (!nameIds.has(n.toLowerCase())) nameIds.set(n.toLowerCase(), 0);
    } catch { /* 下次再试 */ }
  }
  return new Map(names.filter(Boolean).map((n) => [n.trim().toLowerCase(), nameIds.get(n.trim().toLowerCase()) || 0]));
}
// 已经查过的名字（同步取，给渲染用）：{ char, corp, alliance } 或 null
export function entByName(name) {
  const id = nameIds.get(String(name || '').trim().toLowerCase());
  return id ? { char: id, ...(aff.get(id) || {}) } : null;
}
// 只有角色 ID 时（合同发起人等）：同步取已查到的军团 / 联盟
export const entById = (id) => (id ? { char: Number(id), ...(aff.get(Number(id)) || {}) } : null);
// 角色 ID 列表 → 补齐军团 / 联盟；有新查到的才通知重画；没绑定 / 没声望数据时不查
export async function lookupIds(ids) {
  if (!current()) return;
  const now = Date.now();
  const need = ids.filter((id) => id && !(aff.get(Number(id))?.at > now - AFF_TTL) && !(tried.get('i' + id) > now - 60e3));
  if (!need.length) return;
  need.forEach((id) => tried.set('i' + id, now));   // 查失败时一分钟内不再查（渲染里调用也不会循环请求）
  await affiliation(need);
  notify();
}
// 名字列表 → 补齐 ID 与军团 / 联盟；查到新名字才通知重画（渲染里调用也不会循环）
export async function lookupNames(names) {
  if (!current()) return;
  const now = Date.now();
  const need = names.filter((n) => n && !nameIds.has(n.trim().toLowerCase()) && !(tried.get('n' + n.trim().toLowerCase()) > now - 60e3));
  if (!need.length) return;
  need.forEach((n) => tried.set('n' + n.trim().toLowerCase(), now));
  const ids = await idsByName(need);
  await affiliation([...ids.values()]);
  notify();
}
