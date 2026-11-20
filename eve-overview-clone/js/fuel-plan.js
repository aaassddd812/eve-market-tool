// ===== 个人中心 · 军团建筑：统一添油 =====
// 这次带了 F 个燃料块，分给各建筑，让加完以后一起到期，下次一趟加完。
//   每座建筑每小时耗油 c 块，现有燃料用到 E 小时后；统一到 T 小时后，要加 c × (T − E) 块。
//   按带的燃料分：Σ c × (T − E) = F → T = (F + Σ c·E) / Σ c。现有燃料已经撑过 T 的建筑不加，
//     去掉它们重算，直到剩下的都撑不过 T（剩下的里面 E 最小的一定撑不过，所以不会全去掉）。
//     燃料块是整数：先向下取整，差的几块按小数部分从大到小一座补一块，合计正好是 F。
//   按目标时间算：给定 T，每座要加 c × (T − E)（向上取整，撑过 T 的不加），再算合计要带多少。
// 每小时耗油按装的服务模块算（ind-rigs.json 的 fuel，build_ind_rigs.mjs 从 SDE 生成）：
//   模块每小时燃料（serviceModuleFuelAmount）×（1 + 建筑对该组模块的减免 %），只算在线的模块。
//   装配读得到（军团资产，要总监）就按装配；读不到就按 ESI 列出的服务名认模块；FLEX 建筑、梅特诺克斯按自带的模块。
//   认不出或者不对的，每天耗油直接改，改过的存本机（按服务器、军团）。
// 手动加的建筑（不在这个军团、或者 ESI 没列出的）：名称、每天耗油、现有燃料（块数或天数）。
import { serverKey } from './server.js?v=s4';
import * as IS from './ind-structs.js?v=6';

let ctx;
const KEY = () => serverKey('eve-fuel-plan');
const BLOCK_M3 = 5;   // 燃料块每块 5 m³
const CUR = { d: null, corp: 0 };   // 最近一次画的军团建筑数据（输入时重算用）
// 页面翻译只管页面上的字：复制出去的清单、title 里的模块名自己翻
const EN = () => window.I18N?.lang === 'en';
const tr = (s) => (EN() && window.I18N.t ? window.I18N.t(s) : s);
// ESI 服务名 → 服务模块（中英文都认）。按顺序匹配：超级旗舰在旗舰前，旗舰在普通制造前；同一个模块的几项服务（研究的材料 / 时间 / 拷贝）合成一个
const SVC_NAME = [
  [35877, /super\s*cap|超级旗舰|超旗/i], [35881, /capital|旗舰/i], [35878, /manufactur|制造|生产/i],
  [35886, /invention|发明/i], [35891, /research|copy|研究|拷贝|复制/i],
  [35892, /market|市场/i], [35894, /clon|克隆/i], [35899, /reprocess|refin|精炼|提炼|化矿/i], [45009, /moon|卫星|月矿/i],
  [45537, /composite|复合/i], [45538, /hybrid|混合/i], [45539, /biochem|生化/i], [45537, /reaction|反应/i]
];
// 装配里的模块 → 它提供的服务（判断在线）：三岛研究实验室和研究实验室同一类服务
const MOD_NAME = new Map(SVC_NAME.map(([t, re]) => [t, re]).reverse());
MOD_NAME.set(45550, MOD_NAME.get(35891));

export function initFuelPlan(c) { ctx = c; }
const esc = (s) => ctx.esc(s);

// ---------- 本机设置 ----------
// { [军团]: { open, mode: 'amount'|'time', amount, days, rate: { 建筑: 每天块数 }, pick: { 建筑: 是否参与 }, extra: [{ k, name, day, left, unit: 'b'|'d', on }] } }
function all() { return ctx.store.getJSON(KEY(), {}) || {}; }
function cfg(corp = CUR.corp) {
  const c = all()[corp] || {};
  return { open: !!c.open, mode: c.mode === 'time' ? 'time' : 'amount', amount: c.amount ?? '', days: c.days ?? 30, rate: c.rate || {}, pick: c.pick || {}, extra: Array.isArray(c.extra) ? c.extra : [] };
}
function save(c, corp = CUR.corp) { const a = all(); a[corp] = c; ctx.store.setJSON(KEY(), a); }

export const isOpen = (corp) => cfg(corp).open;
export function toggle(corp = CUR.corp) { const c = cfg(corp); c.open = !c.open; save(c, corp); return c.open; }

// 「20万」「20w」「200k」「200,000」→ 200000
export function parseAmount(v) {
  const m = /^([\d.]+)\s*(w|万|k|千)?$/i.exec(String(v ?? '').replace(/[,，\s]/g, ''));
  if (!m) return NaN;
  const k = { w: 1e4, '万': 1e4, k: 1e3, '千': 1e3 }[(m[2] || '').toLowerCase()] || 1;
  return Math.floor(Number(m[1]) * k);
}

// ---------- 每小时耗油 ----------
// 返回 { h 每小时块数, mods: [[模块名, 每小时, 减免前每小时]], src: 'fit'|'svc'|'pre'|'', unknown: [认不出的服务名] }
export function autoRate(s, d) {
  const F = IS.rigData()?.fuel;
  if (!F) return { h: 0, mods: [], src: '', unknown: [] };
  const hull = F.hull[s.type_id] || {};
  const services = s.services || [];
  const lowPower = !s.fuel_expires;
  // 低功率的建筑：服务都没上线，按全部服务上线算（加了燃料再上线）
  const isOn = (x) => lowPower || x.state === 'online';
  const modType = (name) => SVC_NAME.find(([, re]) => re.test(name || ''))?.[0] || 0;
  let types = [];
  let src = '';
  const unknown = [];
  const fit = d.fits?.get(s.structure_id)?.filter((x) => /^ServiceSlot\d$/.test(x.f) && F.svc[x.t]);
  if (fit?.length) {
    src = 'fit';
    for (const x of fit) {
      const re = MOD_NAME.get(x.t);
      const own = re ? services.filter((v) => re.test(v.name || '')) : [];
      // ESI 列出了它的服务就看在不在线；没列出的当作在线
      if (!own.length || own.some(isOn)) types.push(x.t);
    }
  } else if (hull.pre) {
    // FLEX 建筑、梅特诺克斯：服务模块是固定的
    types = [hull.pre]; src = 'pre';
  } else if (services.length) {
    src = 'svc';
    for (const v of services) {
      const t = modType(v.name);
      if (!t) { unknown.push(v.name); continue; }
      if (isOn(v) && !types.includes(t)) types.push(t);
    }
  }
  const mods = types.map((t) => {
    const m = F.svc[t];
    return [EN() ? m.en : m.n, m.h * (1 + (hull.b?.[m.g] || 0) / 100), m.h];
  });
  return { h: mods.reduce((t, m) => t + m[1], 0), mods, src, unknown };
}

// ---------- 计算 ----------
// rows: [{ key, day 每天耗油, E 现有燃料用到几小时后, on }] → { T, add: Map(key -> 块), end: Map(key -> 小时), total, skipped: [key] }
export function solve(rows, mode, amount, days) {
  const act = rows.filter((r) => r.on && r.day > 0).map((r) => ({ r, c: r.day / 24 }));
  const add = new Map(), end = new Map(), skipped = [];
  if (!act.length) return { T: null, add, end, total: 0, skipped };
  let T;
  let set = act;
  if (mode === 'time') {
    T = Math.max(0, days) * 24;
    for (const a of act) add.set(a.r.key, Math.max(0, Math.ceil(a.c * (T - a.r.E) - 1e-9)));
  } else {
    const F = Math.max(0, Math.floor(amount) || 0);
    set = [...act].sort((a, b) => a.r.E - b.r.E);
    for (;;) {
      const C = set.reduce((t, a) => t + a.c, 0);
      T = (F + set.reduce((t, a) => t + a.c * a.r.E, 0)) / C;
      // 剩下一座时 T 就是它自己的到期（F = 0 时浮点可能差一点点，不能把它也去掉）
      if (set.length === 1 || set.at(-1).r.E <= T + 1e-9) break;
      set.pop();
    }
    const exact = set.map((a) => ({ a, x: Math.max(0, a.c * (T - a.r.E)) }));
    for (const e of exact) e.n = Math.floor(e.x);
    let rest = F - exact.reduce((t, e) => t + e.n, 0);
    const byFrac = [...exact].sort((p, q) => (q.x - q.n) - (p.x - p.n));
    for (let i = 0; rest > 0 && byFrac.length; i = (i + 1) % byFrac.length, rest--) byFrac[i].n++;
    for (const a of act) add.set(a.r.key, 0);
    for (const e of exact) add.set(e.a.r.key, e.n);
  }
  for (const a of act) {
    const n = add.get(a.r.key);
    if (!n) skipped.push(a.r.key);
    end.set(a.r.key, a.r.E + n / a.c);
  }
  const total = [...add.values()].reduce((t, n) => t + n, 0);
  return { T, add, end, total, skipped };
}

// ---------- 界面 ----------
const fmtDays = (h) => ctx.left(h * 3600e3);
const at = (h) => ctx.fmtDate(new Date(Date.now() + h * 3600e3).toISOString());
const num = (v) => ctx.formatNumber(Math.round(v));
const rateText = (h) => (Math.round(h * 100) / 100).toString();

function rowsOf(d, c) {
  const out = [];
  for (const s of d.list) {
    const auto = autoRate(s, d);
    const key = String(s.structure_id);
    const ov = c.rate[key];
    const day = ov != null ? Number(ov) : auto.h * 24;
    const ms = s.fuel_expires ? new Date(s.fuel_expires) - Date.now() : null;
    out.push({ key, s, auto, ov: ov != null, day, E: ms == null ? 0 : Math.max(0, ms / 3600e3), low: ms == null, on: c.pick[key] ?? (ms != null && day > 0) });
  }
  for (const x of c.extra) {
    const day = Number(x.day) || 0, left = Number(x.left) || 0;
    out.push({ key: x.k, x, day, E: x.unit === 'd' ? left * 24 : day > 0 ? left / (day / 24) : 0, on: x.on !== false });
  }
  return out;
}

const SRC_ZH = { fit: '按装配', svc: '按服务估算', pre: '按自带模块' };
function rowHtml(r, d) {
  const esc = ctx.esc;
  const on = `<input type="checkbox" data-fuel-on${r.on ? ' checked' : ''} aria-label="参与这次添油">`;
  const dayIn = `<input type="number" class="pi-input fuel-num" data-fuel-day min="0" step="1" value="${r.day ? Math.round(r.day * 100) / 100 : ''}" placeholder="块 / 天" aria-label="每天耗油">`;
  let name, dayHint, left;
  if (r.x) {
    name = `<span class="fuel-manual"><input type="text" class="pi-input" data-fuel-name value="${esc(r.x.name || '')}" placeholder="建筑名" aria-label="建筑名"><button class="icon-btn small" data-fuel-del title="删除这一行"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></span>`;
    dayHint = '<span class="cell-sub">手动</span>';
    left = `<span class="fuel-left"><input type="number" class="pi-input fuel-num" data-fuel-left min="0" step="any" value="${r.x.left ?? ''}" aria-label="现有燃料">` +
      `<select class="cr-input" data-fuel-unit aria-label="单位"><option value="b"${r.x.unit !== 'd' ? ' selected' : ''}>块</option><option value="d"${r.x.unit === 'd' ? ' selected' : ''}>天</option></select></span>`;
  } else {
    const s = r.s, a = r.auto;
    name = `<b>${esc(s.name || ctx.locationName(s.structure_id))}</b><span class="cell-sub">${esc(d.types.get(s.type_id) || s.type_id)}</span>`;
    const title = a.mods.map(([n, h, base]) => `${n} ${rateText(h)}${h !== base ? `（${rateText(base)}）` : ''}`).join(' · ') + (a.unknown.length ? ' · ' + a.unknown.join(' / ') : '');
    // 每段字单独一个元素，英文界面逐段翻译
    dayHint = r.ov ? `<span class="cell-sub"><span>已改</span> · <button class="link-btn" data-fuel-reset>恢复 ${num(a.h * 24)}</button></span>`
      : a.src ? `<span class="cell-sub" title="${esc(title)}"><span>${SRC_ZH[a.src]}</span> · <span>每小时 ${rateText(a.h)}</span>${a.unknown.length ? ' · <span class="warn-text">有服务没认出</span>' : ''}</span>`
      : `<span class="cell-sub warn-text">${a.unknown.length ? '没认出服务，请填' : '没有服务模块'}</span>`;
    left = r.low ? '<span class="muted-cell">无燃料 / 低功率</span>' : `${esc(fmtDays(r.E))}<span class="cell-sub" data-fuel-out="have">${r.day ? '约 ' + num(r.day / 24 * r.E) + ' 块' : ''}</span>`;
  }
  return `<tr data-fuel-row="${esc(r.key)}"${r.on ? '' : ' class="off"'}><td>${on}</td><td>${name}</td><td>${dayIn}${dayHint}</td><td>${left}</td>` +
    '<td class="fuel-add" data-fuel-out="add"></td><td data-fuel-out="end"></td></tr>';
}

export function html(d, corp) {
  CUR.d = d; CUR.corp = corp;
  const c = cfg(corp);
  if (!c.open) return '';
  if (!IS.rigData()?.fuel) return '<div class="fuel-plan"><p class="text-muted">读不到耗油数据（ind-rigs.json）</p></div>';
  // 和下面的建筑表一样按燃料到期排，低功率的在后，手动加的在最后
  const rows = rowsOf(d, c).sort((a, b) => !!a.x - !!b.x || (a.x ? 0 : a.low - b.low || a.E - b.E));
  const seg = (k, l) => `<button data-fuel-mode="${k}" class="${c.mode === k ? 'active' : ''}">${l}</button>`;
  return `<div class="fuel-plan" data-fuel-plan>
    <div class="fuel-head"><h3>统一添油</h3><span class="text-muted">把这次带的燃料块分给各建筑，加完以后一起到期，下次一趟加完</span><span class="toolbar-spacer"></span><button class="btn btn-ghost" data-fuel-toggle aria-expanded="true">收起</button></div>
    <div class="fuel-ctl">
      <div class="segmented" role="group">${seg('amount', '按带的燃料分')}${seg('time', '按目标时间算')}</div>
      ${c.mode === 'amount'
        ? `<label class="fuel-in">这次带了<input type="text" class="pi-input" data-fuel-amount inputmode="numeric" value="${ctx.esc(String(c.amount))}" placeholder="如 200000、20万">块</label>`
        : `<label class="fuel-in">统一到<input type="number" class="pi-input" data-fuel-days min="0" step="any" value="${ctx.esc(String(c.days))}">天后</label>`}
    </div>
    <div class="valuation-grid" data-fuel-sum></div>
    <div class="table-scroll"><table class="pc-mini-table fuel-table"><thead><tr><th></th><th>建筑</th><th>每天耗油</th><th>现有燃料</th><th>添加</th><th>加完到期</th></tr></thead>
      <tbody>${rows.map((r) => rowHtml(r, d)).join('')}</tbody></table></div>
    <div class="fuel-foot"><button class="btn btn-ghost" data-fuel-add>＋ 手动加一座建筑</button><span class="toolbar-spacer"></span><button class="btn" data-fuel-copy>复制添油清单</button></div>
    <p class="valuation-note">每天耗油按装的服务模块算（SDE 数据，已含建筑的燃料减免，只算在线的服务），可以直接改，改过的存在本机。燃料按整块分，各座到期时间相差不到 1 小时。低功率的建筑默认不参与，勾上后按全部服务上线算（上线服务另要一次启动燃料）。ESI 的燃料到期时间最多晚 1 小时更新。</p>
  </div>`;
}

// 算一遍，把结果填进表格和汇总（不重画输入框，打字不丢焦点）
let last = null;
export function update(box) {
  const root = box.querySelector('[data-fuel-plan]');
  if (!root || !CUR.d) return;
  const c = cfg();
  const rows = rowsOf(CUR.d, c);
  const amount = parseAmount(c.amount);
  const res = solve(rows, c.mode, amount, Number(c.days) || 0);
  last = { rows, res, c };
  const card = ctx.valuationCard;
  const act = rows.filter((r) => r.on && r.day > 0);
  const perDay = act.reduce((t, r) => t + r.day, 0);
  const sum = root.querySelector('[data-fuel-sum]');
  if (res.T == null) sum.innerHTML = `<p class="text-muted">${rows.some((r) => r.on) ? '勾上的建筑都没填每天耗油' : '勾选要添油的建筑'}</p>`;
  else if (c.mode === 'amount' && !(amount > 0)) sum.innerHTML = `<p class="text-muted">${String(c.amount).trim() ? '燃料块数量看不懂，填数字，比如 200000 或 20万' : '填这次带了多少燃料块'}</p>`;
  else {
    sum.innerHTML = card('统一到期', esc(at(res.T)), '还剩 ' + esc(fmtDays(res.T)), 'is-buy') +
      card(c.mode === 'amount' ? '合计添加' : '需要带', num(res.total) + ' 块', `${num(res.total * BLOCK_M3)} m³ · ${act.length - res.skipped.length} 座要加`) +
      card('每天合计耗油', num(perDay) + ' 块', `${act.length} 座参与`) +
      (res.skipped.length ? card('不用加', res.skipped.length + ' 座', '现有燃料已经撑过统一到期') : '');
  }
  for (const r of rows) {
    const tr = root.querySelector(`[data-fuel-row="${CSS.escape(r.key)}"]`);
    if (!tr) continue;
    tr.classList.toggle('off', !r.on);
    const have = tr.querySelector('[data-fuel-out="have"]');
    if (have) have.textContent = r.day ? '约 ' + num(r.day / 24 * r.E) + ' 块' : '';
    const n = res.add.get(r.key);
    const okAmount = c.mode === 'time' || amount > 0;
    tr.querySelector('[data-fuel-out="add"]').innerHTML = !r.on ? '<span class="muted-cell">不参与</span>' : !(r.day > 0) ? '<span class="muted-cell">—</span>'
      : !okAmount ? '' : n ? `<b>${num(n)}</b><span class="cell-sub">${num(n * BLOCK_M3)} m³</span>` : '<span class="muted-cell">不用加</span>';
    const e = res.end.get(r.key);
    tr.querySelector('[data-fuel-out="end"]').innerHTML = !r.on || e == null || !okAmount ? '' : `${esc(at(e))}<span class="cell-sub">还剩 ${esc(fmtDays(e))}</span>`;
  }
}

// 重画时保住正在打字的输入框（装配读完会再画一次表）
export function keepFocus(box, fn) {
  const a = document.activeElement;
  const attr = a && box.contains(a) && a.closest('[data-fuel-plan]') ? [...a.attributes].find((x) => x.name.startsWith('data-fuel-'))?.name : null;
  const row = attr ? a.closest('[data-fuel-row]')?.dataset.fuelRow : null;
  const sel = attr && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  if (!attr) return;
  const el = (row != null ? box.querySelector(`[data-fuel-row="${CSS.escape(row)}"]`) : box)?.querySelector(`[${attr}]`);
  if (!el) return;
  el.focus();
  if (sel) try { el.setSelectionRange(...sel); } catch { /* number 输入框不支持 */ }
}

// ---------- 事件（profile-more 的 box 上委托过来）----------
function rowCfg(c, tr) {
  const key = tr.dataset.fuelRow;
  return { key, x: c.extra.find((x) => x.k === key) };
}
export function onInput(e, box) {
  const t = e.target;
  if (!t.closest('[data-fuel-plan]')) return false;
  const c = cfg();
  if (t.matches('[data-fuel-amount]')) c.amount = t.value;
  else if (t.matches('[data-fuel-days]')) c.days = t.value;
  else {
    const tr = t.closest('[data-fuel-row]');
    if (!tr) return true;
    const { key, x } = rowCfg(c, tr);
    if (t.matches('[data-fuel-on]')) { if (x) x.on = t.checked; else c.pick[key] = t.checked; }
    else if (t.matches('[data-fuel-day]')) {
      const v = t.value === '' ? null : Math.max(0, Number(t.value));
      if (x) x.day = v ?? 0;
      else if (v == null) delete c.rate[key]; else c.rate[key] = v;
    } else if (x && t.matches('[data-fuel-name]')) x.name = t.value;
    else if (x && t.matches('[data-fuel-left]')) x.left = t.value === '' ? 0 : Math.max(0, Number(t.value));
    else if (x && t.matches('[data-fuel-unit]')) x.unit = t.value === 'd' ? 'd' : 'b';
    else return true;
  }
  save(c);
  update(box);
  return true;
}

// 返回 true 表示处理了；rerender() 重画整个建筑视图
export function onClick(e, box, rerender) {
  const t = e.target;
  const mode = t.closest('[data-fuel-mode]');
  if (mode) { const c = cfg(); c.mode = mode.dataset.fuelMode; save(c); rerender(); return true; }
  if (t.closest('[data-fuel-add]')) {
    const c = cfg();
    c.extra.push({ k: 'm' + Date.now().toString(36), name: '', day: 0, left: 0, unit: 'b', on: true });
    save(c); rerender();
    box.querySelector('[data-fuel-plan] tbody tr:last-child [data-fuel-name]')?.focus();
    return true;
  }
  const tr = t.closest('[data-fuel-row]');
  if (tr && t.closest('[data-fuel-del]')) { const c = cfg(); c.extra = c.extra.filter((x) => x.k !== tr.dataset.fuelRow); save(c); rerender(); return true; }
  if (tr && t.closest('[data-fuel-reset]')) { const c = cfg(); delete c.rate[tr.dataset.fuelRow]; save(c); rerender(); return true; }
  if (t.closest('[data-fuel-copy]')) { copyList(); return true; }
  return false;
}

async function copyList() {
  if (!last || last.res.T == null || !last.res.total) { ctx.showToast('还没有算出要加的燃料', 'info'); return; }
  const { rows, res } = last;
  const name = (r) => (r.x ? r.x.name || tr('手动加的建筑') : r.s.name || ctx.locationName(r.s.structure_id));
  const lines = rows.filter((r) => res.add.get(r.key) > 0).map((r) => `${name(r)}\t${res.add.get(r.key)}`);
  const text = `${tr('统一到期')} ${at(res.T)}\n` + lines.join('\n') + `\n${tr('合计')}\t${res.total}`;
  try { await navigator.clipboard.writeText(text); ctx.showToast(`已复制添油清单（${lines.length} 座，合计 ${num(res.total)} 块）`, 'success'); }
  catch { ctx.showToast('浏览器阻止了复制，请手动复制', 'error'); }
}
