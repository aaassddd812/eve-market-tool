// ===== 交易税费（全站共用）=====
// 市场详情的倒卖利润、个人资产估值、估价页共用同一套技能与税费设置（保存在本地）。
//   销售税 = 7.5% × (1 − 会计学 11%/级)
//   NPC 空间站中介费 = 3% − 经纪人关系学 0.3%/级 − 派系声望 × 0.03% − 军团声望 × 0.02%（最低 1%）；玩家建筑中介费由主人设定
//   这里的声望是基础声望（不含人脉关系学 / 外交学加成），与游戏内中介费提示一致
// 技能来源：custom 自定义（统一等级 all + 单项 lv，默认全部 5 级）/ char 已绑定角色的 ESI 技能（没学 = 0 级）。
// 声望来源：manual 手填 / char 角色声望（ESI /characters/{id}/standings/），按挂单空间站的所属军团与其阵营取值。
// 其它页面（估价页的化矿技能）也可以用 level() 与 skillFormHtml() 共享这套技能设置。

import { SERVER } from './server.js?v=s4';

const KEY = 'eve-trade-fees-v1';
export const SKILL = { accounting: 16622, brokerRel: 3446 };
export const TRADE_SKILLS = [[SKILL.accounting, '会计学'], [SKILL.brokerRel, '经纪人关系学']];
const LEVELS = [0, 1, 2, 3, 4, 5];

const T = { src: 'custom', all: 5, lv: {}, market: 'npc', fac: 0, corp: 0, broker: 1, stand: 'manual', hub: 0 };
let ctx = null;          // esc, showToast, getCharacterSkills, getCharacterStandings, stationOwner, officialName, hasEsiToken, openEsiBind
let char = null;         // { id, name, levels: Map }
let charLoading = null;
let charFailAt = 0;      // 读取失败后 1 分钟内不再自动重试
let saved = false;       // 本地已有设置（估价页据此决定是否迁移旧设置）
const subs = new Set();
let stand = null;        // 角色声望：{ id, name, map: Map(from_id -> 基础声望) }
let standLoading = null;
let standFailAt = 0;
let standError = '';
const owners = new Map(); // 空间站 ID -> { corp, faction }（读取后填入）

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function load() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 无痕模式等 */ }
  if (!r || typeof r !== 'object') return;
  saved = true;
  assign(r);
}
function assign(r) {
  if (['custom', 'char'].includes(r.src)) T.src = r.src;
  if (Number.isInteger(r.all) && r.all >= 0 && r.all <= 5) T.all = r.all;
  if (r.lv && typeof r.lv === 'object') {
    T.lv = {};
    for (const [k, v] of Object.entries(r.lv)) if (Number.isInteger(v) && v >= 0 && v <= 5) T.lv[k] = v;
  }
  if (['npc', 'struct'].includes(r.market)) T.market = r.market;
  for (const k of ['fac', 'corp']) if (Number.isFinite(r[k])) T[k] = clamp(r[k], -10, 10);
  if (Number.isFinite(r.broker)) T.broker = clamp(r.broker, 0, 100);
  if (['manual', 'char'].includes(r.stand)) T.stand = r.stand;
  if (Number.isInteger(r.hub)) T.hub = r.hub;
}
function persist() {
  saved = true;
  try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* 存不了就只在本次有效 */ }
}
load();

export function initTradeFees(context) { ctx = context; }
export const settings = () => T;
export const hasSaved = () => saved;
export const character = () => char;
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
function notify() { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } }

export function update(patch) {
  assign({ ...T, ...patch, lv: patch.lv ?? T.lv });
  persist();
  if (T.src === 'char' && !char) loadCharacter(true);
  if (T.stand === 'char') loadStandings(true);
  notify();
}

// 技能等级：角色模式未读取时先按 0 级算，并在后台读取
export function level(id) {
  if (T.src === 'char') {
    if (!char) { loadCharacter(true); return 0; }
    return char.levels.get(Number(id)) || 0;
  }
  return T.lv[id] ?? T.all;
}

export function loadCharacter(silent) {
  if (charLoading) return charLoading;
  if (!ctx?.hasEsiToken?.() || (silent && Date.now() - charFailAt < 60e3)) return Promise.resolve(null);
  charLoading = ctx.getCharacterSkills().then((c) => {
    char = c;
    if (!silent) ctx.showToast(`已读取 ${c.name} 的技能`, 'success');
    notify();
    return c;
  }).catch((e) => {
    charFailAt = Date.now();
    if (!silent) ctx.showToast('读取角色技能失败：' + e.message, 'error', 4000);
    return null;
  }).finally(() => { charLoading = null; });
  return charLoading;
}
// 解绑 / 换角色后清掉缓存的角色技能与声望
export function resetCharacter() { char = null; stand = null; standError = ''; notify(); }

// ----- 角色声望（中介费用）-----
// 挂单空间站：本服务器各交易中心，默认第一个
const hubs = () => SERVER.regions.map((r) => r.hub);
const hubId = () => (hubs().some((h) => h.id === T.hub) ? T.hub : hubs()[0].id);

export function loadStandings(silent) {
  if (standLoading) return standLoading;
  const station = hubId();
  if (!ctx?.hasEsiToken?.() || (silent && ((stand && owners.has(station)) || Date.now() - standFailAt < 60e3))) return Promise.resolve(stand);
  standLoading = Promise.all([ctx.getCharacterStandings(), owners.has(station) ? owners.get(station) : ctx.stationOwner(station)]).then(([st, owner]) => {
    stand = st;
    owners.set(station, owner);
    standError = '';
    if (!silent) ctx.showToast(`已读取 ${st.name} 的声望`, 'success');
    notify();
    return st;
  }).catch((e) => {
    standFailAt = Date.now();
    standError = e.message;
    if (!silent) ctx.showToast('读取角色声望失败：' + e.message, 'error', 4000);
    notify();
    return null;
  }).finally(() => { standLoading = null; });
  return standLoading;
}

// 中介费用的派系 / 军团声望：角色声望模式取挂单空间站所属军团及其阵营，没读到时按 0 算
function standings() {
  if (T.stand !== 'char') return { fac: T.fac, corp: T.corp };
  const owner = owners.get(hubId());
  if (!stand || !owner) { loadStandings(true); return { fac: 0, corp: 0 }; }
  return { fac: stand.map.get(owner.faction) || 0, corp: stand.map.get(owner.corp) || 0, owner };
}

// 税费（比例）：sales 销售税，broker 中介费
export function fees() {
  const sales = 0.075 * (1 - 0.11 * level(SKILL.accounting));
  const broker = T.market === 'struct'
    ? T.broker / 100
    : (({ fac, corp }) => Math.max(0.01, 0.03 - 0.003 * level(SKILL.brokerRel) - 0.0003 * fac - 0.0002 * corp))(standings());
  return { sales, broker };
}
// 到手比例：卖给收单只交销售税，挂卖单再交中介费
export const netBuy = () => 1 - fees().sales;
export const netSell = () => { const f = fees(); return 1 - f.sales - f.broker; };
// 倒卖：挂收单买入（付中介费）→ 挂卖单卖出（付销售税 + 中介费），返回每件税后利润
export function flipProfit(buyPrice, sellPrice) {
  const f = fees();
  return sellPrice * (1 - f.sales - f.broker) - buyPrice * (1 + f.broker);
}

export const pct2 = (v) => (v * 100 + 1e-9).toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '%';
export function summary() {
  const f = fees();
  return `销售税 ${pct2(f.sales)} · 中介费 ${pct2(f.broker)}`;
}
export function skillSummary() {
  if (T.src === 'char') return char ? char.name + ' 的技能' : '角色技能未读取';
  return Object.keys(T.lv).length ? `自定义 · 统一 ${T.all} 级（有单项调整）` : `自定义 · 全部 ${T.all} 级`;
}

// ----- 表单片段：data-tf-* 由 bindForm 统一处理 -----
const esc = (s) => (ctx?.esc ? ctx.esc(s) : String(s));
const seg = (name, items) => `<div class="segmented ap-seg" role="group">${items.map(([v, l]) => `<button type="button" data-tf-set="${name}" data-v="${v}" class="${String(T[name]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const sel = (attr, v) => `<select class="cr-input" ${attr} aria-label="技能等级">${LEVELS.map((n) => `<option value="${n}"${v === n ? ' selected' : ''}>${n}</option>`).join('')}</select>`;

// groups：[[分组名, [[技能ID, 名称], ...]], ...]，默认只有交易技能
export function skillFormHtml(groups = [['交易', TRADE_SKILLS]]) {
  groups = groups.filter(([, list]) => list.length);
  let body;
  if (T.src === 'char') {
    body = char
      ? `<div class="ap-char"><b>${esc(char.name)}</b><button type="button" class="btn btn-ghost btn-sm" data-tf-char>重新读取</button></div>
         ${groups.map(([t, list]) => `<div class="ap-lv-group">${t}</div><div class="ap-lv-list">${list.map(([id, n]) => `<span>${esc(n)}<b>${level(id)}</b></span>`).join('')}</div>`).join('')}`
      : `<div class="ap-char">${ctx?.hasEsiToken?.() ? '<span class="text-muted">技能未读取，按 0 级算</span><button type="button" class="btn btn-primary btn-sm" data-tf-char>读取角色技能</button>' : '<span class="text-muted">还没绑定角色</span><button type="button" class="btn btn-primary btn-sm" data-tf-bind>绑定 ESI</button>'}</div>`;
  } else {
    body = `<div class="cr-fields"><label><span>统一等级</span>${sel('data-tf-all', T.all)}</label></div>
      ${groups.map(([t, list]) => `<div class="ap-lv-group">${t}</div><div class="cr-fields">${list.map(([id, n]) => `<label><span>${esc(n)}</span>${sel(`data-tf-lv="${id}"`, level(id))}</label>`).join('')}</div>`).join('')}`;
  }
  return `<div class="ap-rp-row"><span>来源</span>${seg('src', [['custom', '自定义'], ['char', '角色技能']])}</div>${body}`;
}

function standFormHtml() {
  const num = (k, min, max, step, label) => `<input class="cr-input" type="number" min="${min}" max="${max}" step="${step}" value="${T[k]}" data-tf-num="${k}" aria-label="${label}">`;
  const head = `<div class="ap-rp-row"><span>声望来源</span>${seg('stand', [['manual', '手动填写'], ['char', '角色声望']])}</div>`;
  if (T.stand === 'manual') {
    return head + `<div class="cr-fields">
      <label><span>派系声望</span>${num('fac', -10, 10, 0.01, '派系声望')}</label>
      <label><span>军团声望</span>${num('corp', -10, 10, 0.01, '军团声望')}</label></div>`;
  }
  const hub = hubId();
  const pick = `<label><span>挂单空间站</span><select class="cr-input" data-tf-hub aria-label="挂单空间站">${hubs().map((h) => `<option value="${h.id}"${h.id === hub ? ' selected' : ''}>${esc(ctx?.officialName?.(h.id) || h.name)}</option>`).join('')}</select></label>`;
  let body;
  if (!ctx?.hasEsiToken?.()) {
    body = '<div class="ap-char"><span class="text-muted">还没绑定角色，按 0 声望算</span><button type="button" class="btn btn-primary btn-sm" data-tf-bind>绑定 ESI</button></div>';
  } else {
    const st = standings();
    const name = (id) => esc(ctx?.officialName?.(id) || String(id));
    body = st.owner && stand
      ? `<div class="ap-lv-list"><span>${esc(st.owner.factionName || '无阵营')}<b>${st.fac.toFixed(2)}</b></span><span>${name(st.owner.corp)}<b>${st.corp.toFixed(2)}</b></span></div>
         <div class="ap-char"><span class="text-muted">${esc(stand.name)} 的基础声望</span><button type="button" class="btn btn-ghost btn-sm" data-tf-stand>重新读取</button></div>`
      : `<div class="ap-char"><span class="text-muted">${standError ? '读取失败：' + esc(standError) : standLoading ? '读取中…' : '声望未读取，按 0 算'}</span><button type="button" class="btn btn-primary btn-sm" data-tf-stand>读取角色声望</button></div>`;
  }
  return head + `<div class="cr-fields">${pick}</div>` + body;
}

export function feeFormHtml() {
  const f = fees();
  const num = (k, min, max, step, label) => `<input class="cr-input" type="number" min="${min}" max="${max}" step="${step}" value="${T[k]}" data-tf-num="${k}" aria-label="${label}">`;
  return `
    <div class="ap-rp-row"><span>挂单地点</span>${seg('market', [['npc', 'NPC 空间站'], ['struct', '玩家建筑']])}</div>
    ${T.market === 'npc' ? standFormHtml() : `<div class="cr-fields"><label><span>建筑中介费 %</span>${num('broker', 0, 100, 0.1, '建筑中介费')}</label></div>`}
    <div class="ap-fee"><span>销售税 <b>${pct2(f.sales)}</b></span><span>中介费 <b>${pct2(f.broker)}</b></span></div>
    <p class="ap-rp-tip" title="销售税 7.5% × (1 − 会计学 11%/级)；NPC 中介费 3% − 经纪人关系学 0.3%/级 − 派系声望 × 0.03% − 军团声望 × 0.02%，最低 1%">卖给收单只交销售税，挂卖单另交中介费</p>`;
}

// 绑定一个容器里的 data-tf-* 控件；改动后 update() 会通知所有订阅者
export function bindForm(box) {
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf-set]');
    if (b) { update({ [b.dataset.tfSet]: b.dataset.v }); return; }
    if (e.target.closest('[data-tf-char]')) { char = null; loadCharacter(false); return; }
    if (e.target.closest('[data-tf-stand]')) { stand = null; standFailAt = 0; loadStandings(false); notify(); return; }
    if (e.target.closest('[data-tf-bind]')) { closeFeeDialog(); ctx?.openEsiBind?.(); }
  });
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-tf-all]')) update({ all: Number(t.value), lv: {} });
    else if (t.matches('[data-tf-lv]')) update({ lv: { ...T.lv, [t.dataset.tfLv]: Number(t.value) } });
    else if (t.matches('[data-tf-num]')) update({ [t.dataset.tfNum]: Number(t.value) || 0 });
    else if (t.matches('[data-tf-hub]')) update({ hub: Number(t.value) });
  });
}

// ----- 设置弹窗（市场详情、资产估值用）-----
let modal = null;
function renderDialog() {
  if (!modal || modal.hidden) return;
  modal.querySelector('#tfBody').innerHTML = `
    <div class="tf-sec"><h4>技能</h4>${skillFormHtml()}</div>
    <div class="tf-sec"><h4>税费</h4>${feeFormHtml()}</div>`;
}
export function openFeeDialog() {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'tfModal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'tfTitle');
    modal.innerHTML = `<div class="modal-backdrop" data-tf-close></div>
      <div class="modal-content tf-modal">
        <div class="modal-header"><h3 id="tfTitle">交易税费</h3>
          <button class="modal-close" data-tf-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body" id="tfBody"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-tf-close]')) closeFeeDialog(); });
    bindForm(modal.querySelector('#tfBody'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopImmediatePropagation(); closeFeeDialog(); } }, true);
    onChange(renderDialog);
  }
  modal.hidden = false;
  renderDialog();
  modal.querySelector('.modal-close')?.focus();
  if (T.src === 'char' && !char) loadCharacter(true);
  if (T.stand === 'char' && T.market === 'npc') loadStandings(true);
}
export function closeFeeDialog() { if (modal) modal.hidden = true; }
