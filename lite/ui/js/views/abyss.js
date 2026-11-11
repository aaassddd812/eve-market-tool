// 深渊收益
//   识别每一趟（两种证据合并，同一角色时间重叠的算同一趟）：
//     ESI：程序开着时每 12 秒读一次各角色的位置（esi-location.read_location.v1，ESI 缓存 5 秒），星系 ID 进入 32000000 段 = 进深渊，
//       离开 = 出来；在深渊里同时读舰船，变成太空舱 = 船没了。
//     聊天日志：本地频道换成一个不是任何星系的名字 = 进深渊，换回星系 = 出来（logscan.js 的位置证据，程序没开时跑的也能补上，
//       时间精确到秒，和 ESI 记录重叠时用日志的时间）。也可以手动记录一趟。
//   战斗记录：出来后读游戏日志（gamelog.js）这段时间的战斗统计。
//   收益：出深渊后在游戏货柜里全选按 Ctrl+C，程序自动记入（clip.js；也可以手动粘贴）——进行中或刚结束 30 分钟内的那一趟记为出深渊后的货柜，
//     同一份清单也当作下一趟进深渊前的货柜；可选再粘贴进深渊前的货柜，按差额算（用掉的纤维、弹药、药自动扣掉）；
//     没贴进之前的货柜时，成本 = 选的纤维价格 × 数量 + 其他成本。价格宁静服用本站的吉他价格，国服逐个查交易中心挂单。
//   记录存在本机（localStorage lite-abyss）。
import { accounts, esiAuth, hasScope } from '../esi.js';
import { store } from '../platform.js';
import { typeIcon } from '../servers.js';
import { esc, formatISK, formatNumber, fmtTime, fmtDur, typeName, findTypes, loadTypeNames, lookupName, getPrices, priceOf, isAbyssSystem, resolveNames } from '../data.js';
import { combatStats } from '../gamelog.js';
import * as LS from '../logscan.js';
import * as CLIP from '../clip.js';
import { knownSystem } from '../data.js';

const KEY = 'lite-abyss';
const POLL = 12e3;
const LIMIT = 20 * 60e3;                    // 深渊限时 20 分钟
const PODS = new Set([670, 33328]);         // 太空舱 / 基因改良太空舱
const toast = (m, k, ms) => window.__toast?.(m, k, ms);

const D = store.get(KEY, null) || { runs: [], set: { filament: 0, qty: 1, extra: 0, side: 'sell', monitor: true, range: '7d' } };
D.set.clip ??= true;
D.deleted ||= [];   // 删掉的日志记录：重建时不再加回来
const save = () => store.set(KEY, D);
const live = new Map();   // 角色 ID -> { sys, ship, since }，监控时的最新位置
let box = null, ctxRef = null, sel = null, timer = null, tick = null;

// ---------- 监控 ----------
async function pollOnce() {
  if (!D.set.monitor) return;
  for (const acc of accounts().filter((a) => hasScope(a, 'esi-location.read_location.v1'))) {
    const id = acc.character_id;
    try {
      const loc = await esiAuth(acc, `/characters/${id}/location/`);
      const inAbyss = isAbyssSystem(loc.solar_system_id);
      const open = D.runs.find((r) => r.char === id && !r.end);
      let ship = live.get(id)?.ship || null;
      if (inAbyss || open) {
        try { ship = (await esiAuth(acc, `/characters/${id}/ship/`)).ship_type_id; } catch { /* 没有舰船权限 */ }
      }
      live.set(id, { sys: loc.solar_system_id, ship, at: Date.now() });
      // 在深渊里手动结束的那一趟：离开这个深渊星系之前不重新开始
      const last = D.runs.find((r) => r.char === id);
      const held = last?.end && last.endSys && last.endSys === loc.solar_system_id;
      if (inAbyss && !open && !held) {
        D.runs.unshift(withBefore({ id: Date.now() + '-' + id, char: id, charName: acc.character_name, start: Date.now(), end: 0, sys: loc.solar_system_id, ship, startShip: ship, died: false, filament: D.set.filament, qty: D.set.qty, extra: D.set.extra, auto: true }));
        save();
        toast(`${acc.character_name} 进入深渊，开始计时`);
        refresh();
      } else if (open && inAbyss) {
        if (ship && PODS.has(ship) && !PODS.has(open.startShip)) { open.died = true; save(); }
      } else if (open && !inAbyss) {
        open.end = Date.now();
        if (ship && PODS.has(ship) && !PODS.has(open.startShip)) open.died = true;
        save();
        sel = open.id;
        toast(`${acc.character_name} 出了深渊（${fmtDur(open.end - open.start)}）${open.died ? '，船没了' : '，把货柜粘贴进来估价'}`, open.died ? 'error' : '', 6000);
        analyze(open).then(refresh);
        refresh();
      }
    } catch { /* 网络错误：下一轮再试 */ }
  }
}
export function restartMonitor() {
  clearInterval(timer);
  timer = null;
  if (D.set.monitor && accounts().length) { pollOnce(); timer = setInterval(pollOnce, POLL); }
}

// 进深渊前的货柜：开始前 60 分钟内最后一次复制的清单
function withBefore(run) {
  const c = D.lastCap;
  if (c && !run.before && c.at <= run.start + 60e3 && run.start - c.at < 3600e3) { run.before = c.text; run.beforeSrc = 'clip'; }
  return run;
}

// 剪贴板清单 → 进行中的一趟（最新一份为准），或 30 分钟内刚结束、还没手动填过的一趟；同时留作下一趟进深渊前的货柜
function onCapture(cap) {
  if (!D.set.clip) return;
  const open = D.runs.find((r) => !r.end);
  const recent = D.runs.filter((r) => r.end && Date.now() - r.end < 30 * 60e3 && r.afterSrc !== 'manual').sort((a, b) => b.end - a.end)[0];
  const r = open || recent;
  D.lastCap = { at: cap.at, text: cap.text, id: cap.id };
  if (r && r.afterSrc !== 'manual') {
    r.after = cap.text; r.afterSrc = 'clip'; r.capId = cap.id;
    sel = r.id;
    save();
    toast(`已从剪贴板记入 ${r.charName} ${fmtTime(r.start)} 这一趟的货柜（${cap.rows.length} 项）`);
    if (r.end) appraise(r).then(refresh).catch((e) => toast('估价失败：' + e.message, 'error'));
    refresh();
  } else {
    save();
    toast(`已记下货柜清单（${cap.rows.length} 项），下一趟进深渊时作为进深渊前的货柜`);
  }
}
CLIP.onCapture(onCapture);

// 从聊天日志的本地频道重建每一趟：频道名不是已知星系（也不是虫洞 J 星系、希拉）= 在深渊里
async function isAbyssName(name) {
  if (/abyss|深渊/i.test(name)) return true;
  if (/^J\d{6}$/i.test(name) || /^(thera|希拉)$/i.test(name)) return false;
  return !(await knownSystem(name));
}
let rebuilding = false;
async function rebuildFromLogs() {
  if (rebuilding) return;
  rebuilding = true;
  let changed = false;
  try {
    for (const acc of accounts()) {
      const ev = LS.locations(acc);
      if (!ev.length) continue;
      const spans = [];
      let cur = null;
      for (const [t, , name] of ev) {
        const abyss = await isAbyssName(name);
        if (abyss && !cur) cur = { s: t, e: 0, name };
        else if (!abyss && cur) { cur.e = t; spans.push(cur); cur = null; }
      }
      if (cur && Date.now() - cur.s < 30 * 60e3) spans.push(cur);   // 还在里面（超过 30 分钟没出来的多半是日志不全，不算）
      for (const sp of spans) {
        const lid = 'log-' + acc.character_id + '-' + sp.s;
        if (D.deleted.includes(lid)) continue;
        const r = D.runs.find((x) => x.char === acc.character_id && x.start - 90e3 <= (sp.e || Date.now()) && (x.end || Date.now()) + 90e3 >= sp.s);
        if (r) {
          if (r.logStart === sp.s && r.logEnd === sp.e) continue;
          r.logStart = sp.s; r.logEnd = sp.e;
          if (r.auto || r.source === 'log') { r.start = sp.s; if (sp.e) r.end = sp.e; }   // 日志时间精确到秒，比 12 秒一次的轮询准
          changed = true;
        } else {
          const run = withBefore({ id: lid, source: 'log', char: acc.character_id, charName: acc.character_name, start: sp.s, end: sp.e, logStart: sp.s, logEnd: sp.e, sys: 0, ship: null, startShip: null, died: false, filament: D.set.filament, qty: D.set.qty, extra: D.set.extra, auto: false });
          D.runs.push(run);
          if (sp.e) analyze(run).catch(() => null);
          changed = true;
        }
      }
    }
    if (changed) { D.runs.sort((a, b) => b.start - a.start); save(); refresh(); }
  } finally { rebuilding = false; }
}
LS.onScan(() => { rebuildFromLogs().catch((e) => console.error(e)); });

async function analyze(run) {
  // 计时按轮询，前后各放宽一次轮询的时间；日志里第一 / 最后一次交火用来核对
  const st = await combatStats(run.char, run.charName, run.start - POLL - 60e3, (run.end || Date.now()) + POLL);
  run.combat = st.error ? { error: st.error } : { dmgOut: st.dmgOut, dmgIn: st.dmgIn, hitsOut: st.hitsOut, hitsIn: st.hitsIn, first: st.first, last: st.last, targets: st.targets, notes: st.notes.slice(0, 12) };
  save();
}

// ---------- 货柜解析与估价 ----------
// 游戏里货柜全选复制：「名称<Tab>数量<Tab>分组…」；也认「名称 x 10」「10 x 名称」「名称 10」
function parseCargo(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let name = line, qty = 1;
    if (line.includes('\t')) {
      const cols = line.split('\t');
      name = cols[0];
      const q = (cols[1] || '').replace(/[\s,. ]/g, '');
      qty = /^\d+$/.test(q) ? Number(q) : 1;
    } else {
      let m = /^(.+?)\s*[x×*]\s*([\d,.\s]+)$/i.exec(line) || null;
      if (m) { name = m[1]; qty = Number(m[2].replace(/[\s,.]/g, '')) || 1; }
      else if ((m = /^([\d,.]+)\s*[x×*]\s+(.+)$/i.exec(line))) { name = m[2]; qty = Number(m[1].replace(/[,.]/g, '')) || 1; }
      else if ((m = /^(.+?)\s+([\d,]+)$/.exec(line))) { name = m[1]; qty = Number(m[2].replace(/,/g, '')) || 1; }
    }
    out.push({ name: name.trim(), qty });
  }
  return out;
}
async function resolveCargo(text) {
  const map = new Map(), unknown = [];
  for (const { name, qty } of parseCargo(text)) {
    const id = await lookupName(name);
    if (!id) { unknown.push(name); continue; }
    map.set(id, (map.get(id) || 0) + qty);
  }
  return { map, unknown };
}
async function appraise(run) {
  await loadTypeNames();
  const after = await resolveCargo(run.after);
  const before = run.before?.trim() ? await resolveCargo(run.before) : null;
  const diff = new Map(after.map);
  if (before) for (const [id, q] of before.map) diff.set(id, (diff.get(id) || 0) - q);
  const ids = [...diff.keys()];
  if (!before && run.filament) ids.push(run.filament);
  const prices = await getPrices(ids, { exact: true });
  const side = D.set.side;
  const items = [...diff].filter(([, q]) => q !== 0).map(([id, q]) => ({ id, q, p: priceOf(prices, id, side) })).sort((a, b) => b.q * b.p - a.q * a.p);
  const loot = items.filter((x) => x.q > 0).reduce((t, x) => t + x.q * x.p, 0);
  const used = -items.filter((x) => x.q < 0).reduce((t, x) => t + x.q * x.p, 0);
  const fil = !before && run.filament ? priceOf(prices, run.filament, side) * (run.qty || 1) : 0;
  run.priced = { items, loot, cost: used + fil + (Number(run.extra) || 0), filCost: fil, used, unknown: [...after.unknown, ...(before?.unknown || [])], side, at: Date.now() };
  run.net = run.priced.loot - run.priced.cost;
  save();
}

// ---------- 统计 ----------
const RANGES = [['today', '今天'], ['7d', '7 天'], ['30d', '30 天'], ['all', '全部']];
function rangeFrom(r) {
  if (r === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return r === '7d' ? Date.now() - 7 * 864e5 : r === '30d' ? Date.now() - 30 * 864e5 : 0;
}
function summary(runs) {
  const done = runs.filter((r) => r.end);
  const priced = done.filter((r) => r.priced);
  const ms = priced.reduce((t, r) => t + (r.end - r.start), 0);
  const net = priced.reduce((t, r) => t + r.net, 0);
  return { n: done.length, died: done.filter((r) => r.died).length, priced: priced.length, net, ms, loot: priced.reduce((t, r) => t + r.priced.loot, 0), cost: priced.reduce((t, r) => t + r.priced.cost, 0), perH: ms ? net / (ms / 3600e3) : 0, avg: priced.length ? net / priced.length : 0, avgMs: done.length ? done.reduce((t, r) => t + (r.end - r.start), 0) / done.length : 0 };
}

// ---------- 界面 ----------
// 纤维：名称以「深渊纤维」结尾、不是过期的（宁静与国服同一套物品）
// 排序：先按类型（电子 / 黑暗 / 异种 / 火瀑 / 伽玛），同类型按等级（T0 宁静 … T6 灾变）
const TIERS = ['宁静', '镇静', '焦躁', '猛烈', '狂怒', '混乱', '灾变'];
const KINDS = ['电子', '黑暗', '异种', '火瀑', '伽玛'];
const fKey = (n) => KINDS.findIndex((k) => n.includes(k)) * 10 + TIERS.findIndex((t) => n.startsWith(t));
const filamentOptions = () => findTypes((n) => /深渊纤维$/.test(n) && !/^过期/.test(n)).sort((a, b) => fKey(a[1]) - fKey(b[1]));

function liveHtml() {
  const open = D.runs.filter((r) => !r.end);
  if (!open.length) return '';
  return open.map((r) => {
    const el = Date.now() - r.start, left = LIMIT - el;
    return `<div class="live-run"><span class="pill on">深渊中</span><b>${esc(r.charName)}</b>
      <span class="clock${left < 0 ? ' late' : ''}" data-clock="${r.start}">${fmtClock(el)}</span>
      <span class="left" data-left="${r.start}">${left > 0 ? '剩余 ' + fmtClock(left) : '已超过 20 分钟'}</span>
      ${r.ship ? '<span class="muted">' + esc(typeName(r.ship)) + '</span>' : ''}${r.died ? ' <span class="pill bad">船没了</span>' : ''}
      <span class="grow"></span><button class="btn sm" data-end="${r.id}">手动结束</button></div>`;
  }).join('');
}
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(Math.abs(ms) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

function detailHtml(r) {
  const p = r.priced;
  const fil = filamentOptions();
  const c = r.combat;
  return `<div class="card" id="runDetail">
    <div class="head-row"><h4>${esc(r.charName)} · ${fmtTime(r.start)}<small>${r.end ? fmtDur(r.end - r.start) : '进行中'}${r.source === 'log' ? ' · 聊天日志识别' : r.auto ? ' · 自动记录' : ' · 手动记录'}${r.logStart ? ' · 时间取自日志' : ''}</small></h4>
      ${r.died ? '<span class="pill bad">船没了</span>' : ''}<span class="grow"></span>
      <label class="small muted"><input type="checkbox" data-died ${r.died ? 'checked' : ''}> 船没了</label>
      <button class="btn sm danger" data-del="${r.id}">删除这一趟</button></div>
    <div class="run-detail">
      <div>
        <div class="small muted">出深渊后的货柜${r.afterSrc === 'clip' ? ' <span class="pill on">剪贴板自动记入</span>' : ''}（游戏里货柜全选按 Ctrl+C 会自动记入，也可以粘贴）。货柜里有自己带的纤维、弹药、药，请把右边进深渊前的货柜也贴上，否则会算成战利品</div>
        <textarea rows="7" data-f="after" placeholder="炽热冰冻 深渊纤维&#9;2&#10;…">${esc(r.after || '')}</textarea>
      </div>
      <div>
        <div class="small muted">进深渊前的货柜${r.beforeSrc === 'clip' ? ' <span class="pill on">剪贴板自动记入</span>' : ''}（可选）：贴了就按前后差额算，用掉的纤维、弹药、药自动算进成本</div>
        <textarea rows="7" data-f="before">${esc(r.before || '')}</textarea>
      </div>
      <div class="full row">
        <label class="small">纤维 <select data-f="filament"><option value="0">不扣</option>${fil.map(([id, n]) => `<option value="${id}"${id === r.filament ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label class="small">数量 <input type="number" min="0" step="1" style="width:64px" data-f="qty" value="${r.qty ?? 1}"></label>
        <label class="small">其他成本 <input type="number" min="0" step="100000" style="width:130px" data-f="extra" value="${r.extra || 0}"> ISK</label>
        <span class="muted small">${r.before?.trim() ? '已贴进深渊前的货柜，纤维按差额算，不再单独扣' : '没贴进深渊前的货柜时，按纤维价格 × 数量扣'}</span>
        <span class="grow"></span><button class="btn primary" data-appraise>估价</button>
      </div>
    </div>
    ${p ? `<div class="stats" style="margin-top:12px">
        <div class="stat"><div class="l">净收益</div><div class="v ${r.net >= 0 ? 'up' : 'down'}">${formatISK(r.net)}<small>ISK</small></div><div class="d">${r.end ? '每小时 ' + formatISK(r.net / ((r.end - r.start) / 3600e3)) : ''}</div></div>
        <div class="stat"><div class="l">战利品</div><div class="v">${formatISK(p.loot)}<small>ISK</small></div><div class="d">按${p.side === 'buy' ? '收单' : '卖单'}价 · ${fmtTime(p.at)} 估价</div></div>
        <div class="stat"><div class="l">成本</div><div class="v down">${formatISK(p.cost)}<small>ISK</small></div><div class="d">${p.used ? '消耗 ' + formatISK(p.used) : ''}${p.filCost ? ' 纤维 ' + formatISK(p.filCost) : ''}${r.extra ? ' 其他 ' + formatISK(r.extra) : ''}</div></div>
        <div class="stat"><div class="l">用时</div><div class="v">${r.end ? fmtClock(r.end - r.start) : '—'}</div><div class="d">${c && !c.error && c.first ? '交火 ' + fmtClock(c.last - c.first) : ''}</div></div>
      </div>
      ${p.unknown.length ? `<p class="err">认不出的物品（没计价）：${esc(p.unknown.slice(0, 8).join('、'))}${p.unknown.length > 8 ? ' 等 ' + p.unknown.length + ' 项' : ''}</p>` : ''}
      <div class="loot-list" style="margin-top:10px"><table><tbody>${p.items.map((x) => `<tr class="${x.q < 0 ? 'neg' : ''}"><td><img class="ico" src="${typeIcon(x.id)}" alt="" loading="lazy">${esc(typeName(x.id))}</td><td class="r">${x.q > 0 ? '+' : ''}${formatNumber(x.q)}</td><td class="r">${formatISK(x.p)}</td><td class="r">${formatISK(x.q * x.p)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <h4 style="margin-top:14px">战斗记录（游戏日志）<button class="btn sm ghost" data-analyze>重新读取</button></h4>
    ${!c ? '<p class="muted small">出深渊后自动读取</p>' : c.error ? `<p class="muted small">${esc(c.error)}</p>` : `<div class="combat">
        <div class="stat"><div class="l">造成伤害</div><div class="v">${formatNumber(c.dmgOut)}</div><div class="d">${c.hitsOut} 次命中</div></div>
        <div class="stat"><div class="l">受到伤害</div><div class="v">${formatNumber(c.dmgIn)}</div><div class="d">${c.hitsIn} 次</div></div>
        <div class="stat"><div class="l">第一次交火</div><div class="v" style="font-size:16px">${c.first ? fmtTime(c.first, true) : '—'}</div></div>
        <div class="stat"><div class="l">最后一次交火</div><div class="v" style="font-size:16px">${c.last ? fmtTime(c.last, true) : '—'}</div></div>
      </div>
      ${c.targets?.length ? '<p class="small muted">打得最多：' + c.targets.map(([n, d]) => esc(n) + ' ' + formatNumber(d)).join('、') + '</p>' : ''}
      ${c.notes?.length ? '<details class="small"><summary class="muted">这段时间的系统提示（' + c.notes.length + ' 条）</summary>' + c.notes.map((n) => `<div>${fmtTime(n.t, true)} ${esc(n.text)}</div>`).join('') + '</details>' : ''}`}
  </div>`;
}

const mine = () => box?.isConnected && box.dataset.view === 'abyss';
function draw() {
  if (!mine()) return;
  const from = rangeFrom(D.set.range);
  const runs = D.runs.filter((r) => r.start >= from);
  const s = summary(runs);
  const monitored = accounts().filter((a) => hasScope(a, 'esi-location.read_location.v1'));
  const r = D.runs.find((x) => x.id === sel);
  box.innerHTML = `<div class="card">
    <div class="head-row"><h3>深渊收益</h3>
      <div class="monitor"><span class="dot${D.set.monitor && timer ? ' on' : ''}"></span>
        <label><input type="checkbox" data-monitor ${D.set.monitor ? 'checked' : ''}> 自动识别进出深渊</label>
        ${monitored.length ? '' : '<span class="muted small">没有角色有位置权限，只按聊天日志的本地频道识别</span>'}</div>
      <label class="small"><input type="checkbox" data-clip ${D.set.clip ? 'checked' : ''}> 游戏里复制货柜自动记入</label>
      <span class="grow"></span>
      <button class="btn sm" data-manual>手动记录一趟</button>
    </div>
    ${liveHtml()}
  </div>
  <div class="card">
    <div class="head-row"><h4>统计</h4><span class="grow"></span>
      <div class="segmented">${RANGES.map(([k, l]) => `<button data-range="${k}" class="${D.set.range === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="segmented" title="战利品按吉他卖单最低价还是收单最高价估">${[['sell', '卖单价'], ['buy', '收单价']].map(([k, l]) => `<button data-side="${k}" class="${D.set.side === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="l">每小时净收益</div><div class="v">${formatISK(s.perH)}<small>ISK</small></div><div class="d">已估价 ${s.priced} 趟，共 ${fmtDur(s.ms)}</div></div>
      <div class="stat"><div class="l">净收益合计</div><div class="v ${s.net >= 0 ? 'up' : 'down'}">${formatISK(s.net)}<small>ISK</small></div><div class="d">战利品 ${formatISK(s.loot)} − 成本 ${formatISK(s.cost)}</div></div>
      <div class="stat"><div class="l">平均每趟</div><div class="v">${formatISK(s.avg)}<small>ISK</small></div><div class="d">平均用时 ${s.avgMs ? fmtClock(s.avgMs) : '—'}</div></div>
      <div class="stat"><div class="l">趟数</div><div class="v">${s.n}<small>趟</small></div><div class="d">${s.died ? '<span class="down">船没了 ' + s.died + ' 趟</span>' : '全部成功'}${s.n - s.priced ? ' · ' + (s.n - s.priced) + ' 趟没估价' : ''}</div></div>
    </div>
  </div>
  ${r ? detailHtml(r) : ''}
  <div class="card"><h4>每一趟<small>点一行录入货柜、看战斗记录</small></h4>
    ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>开始</th><th>角色</th><th>舰船</th><th class="r">用时</th><th class="r">战利品</th><th class="r">成本</th><th class="r">净收益</th><th class="r">每小时</th><th></th></tr></thead><tbody>
      ${runs.map((x) => `<tr class="clickable${x.id === sel ? ' sel' : ''}" data-run="${x.id}"><td>${fmtTime(x.start)}</td><td>${esc(x.charName)}</td><td>${x.startShip ? esc(typeName(x.startShip)) : '—'}</td>
        <td class="r">${x.end ? fmtClock(x.end - x.start) : '<span class="pill on">进行中</span>'}</td>
        <td class="r">${x.priced ? formatISK(x.priced.loot) : '—'}</td><td class="r">${x.priced ? formatISK(x.priced.cost) : '—'}</td>
        <td class="r ${x.priced ? (x.net >= 0 ? 'up' : 'down') : ''}"><b>${x.priced ? formatISK(x.net) : '—'}</b></td>
        <td class="r">${x.priced && x.end ? formatISK(x.net / ((x.end - x.start) / 3600e3)) : '—'}</td>
        <td>${x.died ? '<span class="pill bad">船没了</span>' : x.end && !x.priced ? '<span class="pill warn">待录入货柜</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">还没有记录。开着程序跑深渊会自动记录；也可以点「手动记录一趟」。</p>'}
  </div>`;
}
function refresh() { if (mine()) draw(); }

function fieldChange(e) {
  const r = D.runs.find((x) => x.id === sel);
  const f = e.target.dataset.f;
  if (!r || !f) return;
  r[f] = f === 'filament' || f === 'qty' || f === 'extra' ? Number(e.target.value) || 0 : e.target.value;
  if (f === 'after') r.afterSrc = 'manual';
  if (f === 'before') r.beforeSrc = 'manual';
  if (f === 'filament') D.set.filament = r.filament;
  if (f === 'qty') D.set.qty = r.qty;
  save();
}

async function onClick(e) {
  const t = e.target;
  const rangeB = t.closest('[data-range]');
  if (rangeB) { D.set.range = rangeB.dataset.range; save(); draw(); return; }
  const sideB = t.closest('[data-side]');
  if (sideB) { D.set.side = sideB.dataset.side; save(); draw(); return; }
  const endB = t.closest('[data-end]');
  if (endB) { const r = D.runs.find((x) => x.id === endB.dataset.end); if (r) { r.end = Date.now(); r.endSys = live.get(r.char)?.sys || r.sys; sel = r.id; save(); analyze(r).then(refresh); draw(); } return; }
  if (t.closest('[data-manual]')) { manualRun(); return; }
  const del = t.closest('[data-del]');
  if (del) {
    if (confirm('删除这一趟的记录？')) {
      if (del.dataset.del.startsWith('log-')) D.deleted = [...D.deleted, del.dataset.del].slice(-300);
      D.runs = D.runs.filter((x) => x.id !== del.dataset.del); sel = null; save(); draw();
    }
    return;
  }
  if (t.closest('[data-appraise]')) {
    const r = D.runs.find((x) => x.id === sel);
    if (!r) return;
    if (!r.after?.trim()) { toast('先把出深渊后的货柜粘贴进来', 'error'); return; }
    t.disabled = true; t.textContent = '估价中…';
    try { await appraise(r); } catch (err) { toast('估价失败：' + err.message, 'error', 5000); }
    draw();
    return;
  }
  if (t.closest('[data-analyze]')) {
    const r = D.runs.find((x) => x.id === sel);
    if (r) { t.disabled = true; await analyze(r); draw(); }
    return;
  }
  const row = t.closest('[data-run]');
  if (row) {
    sel = sel === row.dataset.run ? null : row.dataset.run;
    draw();
    if (sel) box.querySelector('#runDetail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // 还没读过日志的（比如程序没开时手动补记的）：点开时读一次
    const r = D.runs.find((x) => x.id === sel);
    if (r?.end && !r.combat) analyze(r).then(refresh);
  }
}

// 手动记录：默认刚刚结束的一趟（20 分钟前开始），时间可在弹出的输入框里改
function manualRun() {
  const list = accounts();
  if (!list.length) return;
  const pad = (n) => String(n).padStart(2, '0');
  const local = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const startS = prompt('开始时间（本地时间，年-月-日 时:分）', local(Date.now() - 20 * 60e3));
  if (!startS) return;
  const endS = prompt('结束时间', local(Date.now()));
  if (!endS) return;
  const start = Date.parse(startS.replace(' ', 'T')), end = Date.parse(endS.replace(' ', 'T'));
  if (!(start < end)) { toast('时间格式不对，或结束早于开始', 'error'); return; }
  const acc = list.find((a) => a.character_id === ctxRef?.acc?.character_id) || list[0];
  const r = { id: start + '-' + acc.character_id, char: acc.character_id, charName: acc.character_name, start, end, sys: 0, ship: null, startShip: null, died: false, filament: D.set.filament, qty: D.set.qty, extra: D.set.extra, auto: false };
  D.runs.push(r);
  D.runs.sort((a, b) => b.start - a.start);
  sel = r.id;
  save();
  analyze(r).then(refresh);
  draw();
}

export async function render(el, acc, ctx) {
  box = el;
  ctxRef = { ...ctx, acc };
  await loadTypeNames().catch(() => null);
  await resolveNames(D.runs.flatMap((r) => [r.startShip, r.ship]).filter(Boolean)).catch(() => null);
  if (!ctx.isCurrent()) return;
  draw();
  el.onclick = onClick;
  el.onchange = (e) => {
    if (e.target.matches('[data-clip]')) { D.set.clip = e.target.checked; save(); return; }
    if (e.target.matches('[data-monitor]')) { D.set.monitor = e.target.checked; save(); restartMonitor(); draw(); return; }
    if (e.target.matches('[data-died]')) { const r = D.runs.find((x) => x.id === sel); if (r) { r.died = e.target.checked; save(); draw(); } return; }
    fieldChange(e);
  };
  el.oninput = (e) => { if (e.target.matches('textarea[data-f]')) fieldChange(e); };
  clearInterval(tick);
  tick = setInterval(() => {
    if (!mine()) { clearInterval(tick); return; }
    box.querySelectorAll('[data-clock]').forEach((n) => { const el2 = Date.now() - Number(n.dataset.clock); n.textContent = fmtClock(el2); n.classList.toggle('late', el2 > LIMIT); });
    box.querySelectorAll('[data-left]').forEach((n) => { const left = LIMIT - (Date.now() - Number(n.dataset.left)); n.textContent = left > 0 ? '剩余 ' + fmtClock(left) : '已超过 20 分钟'; });
  }, 1000);
}
