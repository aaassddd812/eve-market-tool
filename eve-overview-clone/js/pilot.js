// ===== 驾驶模拟：自己开一艘船，像在游戏里一样走位、锁定、开关装备打 NPC =====
// 复用战场模拟：sim-engine.js（逐 0.5 秒推进，玩家这艘船用 B.takeControl 交给手动控制）、sim-3d.js（游戏内舰船模型、特效）、
// fit-sim.js 的装配 → 战斗单位转换（pilotRow）。敌人按战场模拟的 AI 行动（锁定、走位、开火都和战场模拟一样）。
// 界面用游戏客户端的原版贴图（tools/ui-assets/fetch.mjs 从 CCP 公开资源服务器下载到 assets/eveui/，版权归 CCP）按游戏布局拼：
//   底部中间：船体面板（护盾 / 装甲 / 结构表盘、电容格、速度条，点速度条调速度），右边是装备栏（点击 / F1–F8 开关）；
//   上方：已锁定的目标（三层血弧、锁定倒计时，点一下设为当前目标）；右上：选中目标的操作（靠近 / 环绕 / 保持距离 / 锁定 / 解锁）；
//   右侧：总览（按距离排序，点击选中，Ctrl + 点击锁定，双击靠近）；太空里：锁定框、当前目标箭头、选中圈。
// 快捷键与游戏一致：按住 Q / W / E 点船 = 靠近 / 环绕 / 保持距离，Ctrl + 点船 = 锁定，双击太空 = 朝那个方向飞，Ctrl + 空格 = 停船，
//   Ctrl + D = 战术视图（距离网格、武器射程、竖线，默认打开）。
// 起飞后先显示加载画面（游戏的转圈贴图 + 进度条），等舰船模型、星空、特效贴图、界面贴图都加载完才开始计时；
// 特效用游戏的粒子 / 爆炸序列 / 光束贴图（sim-fx.js opt.tex）；鼠标指针用游戏的指针贴图（css .pl-stage）。
import { createBattle, GRID, AU as AU_M } from './sim-engine.js?v=v37';
import { loadShipIndex } from './sim-ships.js?v=v18';
import { warpShake } from './sim-warp.js?v=3';
import { makeRules, applyRackSnap, MATCH_CAPS, MATCH_BRACKETS, bracketOf, celOf, matchSky } from './pilot-rules.js?v=v10';
import { bindUnit, pilotUnit } from './sim-unit.js?v=v8';
import { buildMatch, stepMatch } from './match-sim.js?v=v10';
import { MT, matchConnect, matchSend, fetchPresets, fetchPreset } from './pilot-match.js?v=v4';
import { initTutor, tutListHtml, tutSpec, tutBegin, tutTick, tutEnd, tutStop } from './pilot-tutor.js?v=v20';
import * as FL from './pilot-fleet.js?v=6';
import * as SC from './pilot-scan.js?v=6';
import * as ST from './pilot-site.js?v=15';
import * as CG from './pilot-cargo.js?v=2';

let ctx = null;
let root = null;
const KEY = 'eve-pilot';
const UI = 'assets/eveui/';
const IMG = (id, kind = 'icon', size = 64) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // 画在画布上的文字不走自动翻译
const DISTS = [10, 20, 30, 50, 80];
// 游戏星空（dx9/scene/universe，tools/ui-assets/fetch.mjs --sky 转换）：艾玛、加达里、盖伦特、米玛塔尔区域各一张
const SKIES = ['a01', 'c01', 'g01', 'm01'];
const SKY_NAME = { '': '随机', a01: '艾玛', c01: '加达里', g01: '盖伦特', m01: '米玛塔尔' };
const DT = 0.5;
const S = {
  set: { ship: 0, fit: 'kb', foes: [], allies: [], dist: 30, sky: '', tac: true, tab: 'solo', ptab: 'rec', mmode: '1v1', mcap: MATCH_CAPS[0], mskill: 'esi', mroomf: '', mpub: true, pfit: null, pid: '', mode: 'free', site: '' },
  b: null, me: null, on: null, off: null, prop: -1, view: null, raf: 0, last: 0, t: 0, paused: false, sel: -1, keys: new Set(),
  names: [], brk: [], log: [], ended: false, loading: false, orbit: 0, keep: 0, ovAt: 0
};
// 驾驶规则（开装备检查、停用等周期跑完、超载烧毁、换弹、锁定…）和匹配服务器共用一份：pilot-rules.js；画面时间 S.t 比战斗慢半拍
// 匹配对战里按服务器的步数算（S.match），不看画面时间
const RL = makeRules(S, { log: (t, k) => { if (!S.replay) pushLog(t, k); }, typeName: (id) => typeName(id), now: () => (S.match ? Infinity : S.t), lockOvl: () => S.hud?.lockOvl });
let R = RL;
// 匹配对战：锁定、开关装备、走位等都不在本地直接改，发给服务器，下一步和所有人的指令一起按顺序执行（本地也是收到那一步才执行）
const mAct = (a) => { matchSend({ op: 'act', a }); return true; };
const RM = {
  ...RL,
  lock: (v) => { if (v && v !== S.me && S.me?.alive) mAct({ a: 'lock', u: v.i }); },
  unlock: (v) => { if (v) mAct({ a: 'unlock', u: v.i }); },
  toggleModule: (m, shift) => mAct({ a: 'tog', m, shift }),
  toggleOverload: (m) => mAct({ a: 'ov', m }),
  setAmmo: (m, type) => mAct({ a: 'ammo', m, type }),
  reloadMods: (list) => mAct({ a: 'reload', list }),
  setRepeat: (m, on) => mAct({ a: 'repeat', m, on }),
  setAutoReload: (m, on) => mAct({ a: 'autoreload', m, on }),
  setSpeed: (f) => mAct({ a: 'speed', f }),
  setDrones: (on) => (S.me?.alive && S.me.drones.length ? mAct({ a: 'drones', on }) : false),
  setMode: (k) => (S.me?.alive && S.modes?.[k] && S.modes[k] !== S.mode && !RL.modeLeft() ? mAct({ a: 'mode', k }) : false),
  setRackOverload: (r, on) => mAct({ a: 'rov', r, on }),
  toggleRackOverload: (r) => mAct({ a: 'rov', r }),
  cmd: (c) => (S.me?.alive ? mAct({ a: 'cmd', cmd: c.cmd, u: c.tgt ? c.tgt.i : undefined, dist: c.dist, dir: c.dir, pt: c.pt }) : false),
  syncGroupState: () => mAct({ a: 'groups', list: [...S.rk.grp] }),
  warpTo: (tgt, dist) => (S.me?.alive && !S.me.warp ? mAct({ a: 'warp', ...(tgt?.cel != null ? { c: tgt.cel } : { u: tgt.i }), dist }) : false),
};

// 星系天体（跃迁目的地，tools/pilot-systems.py 生成）：页面一加载就预读，起飞 / 匹配开局前要用
let SYS = null, sysP = null;
const loadSys = () => (sysP ||= fetch('pilot-systems.json?v=2').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => (SYS = d)));
export function initPilot(context) {
  ctx = context;
  loadSys();
  initTutor({
    S, root: () => root, esc, tr, store: ctx.store, view: () => S.view,
    guns: () => (S.on?.guns || []).map((g) => g.m),
    gunSel: () => { const g = S.on?.guns?.[0]; return g ? `[data-pl-mod="${R.masterOf(g.m)}"]` : null; },
    ovlSel: () => { const g = S.on?.guns?.[0]; return g ? `[data-pl-ovl="${R.masterOf(g.m)}"]` : null; },
    typeName, img: IMG, log: (text, kind) => pushLog(text, kind),
    onFinish: () => { S.ended = true; S.endAt = S.t; },
    fleetReset: (o) => { FL.fleetReset(o); FL.renderFleet(true); },
    broadcast: (k, o) => FL.broadcast(k, o),
    watch: (u) => { FL.watchAdd(u, true); toggleWin('watch', true); },
    winOpen: (id) => { const w = root?.querySelector(`[data-win="${id}"]`); return Boolean(w && !w.hidden); },
    scan: () => SC.scanState(), setSigs: (l) => SC.setSigs(l),
  });
  FL.initFleet({
    S, root: () => root, esc, tr, UI, typeName, icon: (v) => typeIcon(v.r.row.ship, S.brk[v.i] || 'frigate'),
    pick: (i, e) => pickUnit(i, e), lock: (v) => lockUnit(v), warpTo: (tgt, d) => warpTo(tgt, d),
    menu: (items, e) => { hideHint(); closeMenus(); S.cm = items; cmenuAt(e); }, unitMenu: (v, bare) => unitMenu(v, bare),
    sysName: () => SYS?.systems?.[S.sky]?.name || '', log: (t, k) => pushLog(t, k),
    groupName: (id) => ctx.data.groups.get(ctx.data.types.get(id)?.group)?.name || '', warpD: () => warpD(), setWarpD: (d) => ctx.store.setJSON(WARPD_KEY, d),
    alignTo: (tgt) => alignTo(tgt), openWin: (id) => toggleWin(id, true),
  });
  SC.initScan({
    S, root: () => root, esc, tr, UI, typeName, data: () => ctx.data, typeImg: (id) => IMG(id, 'icon', 32), fmtDist, AU,
    ovShows: (t) => ovShows(t), ovShowsGroup: (g) => ovShowsGroup(g), icon: (v) => typeIcon(v.r.row.ship, S.brk[v.i] || 'frigate'),
    iconOf: (t) => typeIcon(t, 'dronelightscout'), celIcon: (c) => celIcon(c), pick: (i, e) => pickUnit(i, e), pickCel: (i, e) => pickCel(i, e),
    menu: (items, e) => { hideHint(); closeMenus(); S.cm = items; cmenuAt(e); }, unitMenu: (v) => unitMenu(v), warpTo: (tgt, d) => warpTo(tgt, d),
    log: (t, k) => pushLog(t, k), openWin: (id, show) => toggleWin(id, show ? true : undefined),
  });
  ST.initSite({
    S, ctx, esc, tr, log: (t, k) => pushLog(t, k), msg: (t) => { pushLog(t, 'sys'); quickMsg(t); },
    finish: (won, text) => { S.siteEnd = { won, text }; end(); }, fade: () => siteFade(),
    approach: (i) => celApproach(i), envFx: (list) => { S.envFx = list; S.view?.setEnvFx?.(list); },
    // 深渊过导管：客户端 JumpOutAbyssalBetween 的跃迁隧道过场（sim-jump.js）；没有 3D 画面就返回 false，调用方退回淡入淡出
    jumpFx: (i, cb) => { if (!S.view?.abyssJump) return false; S.jumpFx = S.view.abyssJump(i, cb); return true; },
    openLoot: (i) => CG.openLoot(i), wreck: () => renderOverview(true),
    rerender: () => { const box = root?.querySelector('#plSites'); if (box) keepScroll(() => { box.innerHTML = ST.siteSetupHtml(S.set.mode, S.set.site, S.set.abyWx); }); },
  });
  CG.initCargo({ S, ctx, esc, tr, UI, IMG, ST, root: () => root, toggleWin: (id, show) => toggleWin(id, show), msg: (t) => { pushLog(t, 'bad'); quickMsg(t); },
    wreckEmpty: (i) => { ST.wreckEmptied(i); renderOverview(true); } });
  const saved = ctx.store.getJSON(KEY, null);
  const ot = Number(ctx.store.getJSON(OV_KEY, 0));
  S.ovTab = ot >= 0 && ot < OV_TABS.length ? ot : 0;
  if (saved && typeof saved === 'object') Object.assign(S.set, { ship: Number(saved.ship) || 0, fit: saved.fit || 'kb', foes: Array.isArray(saved.foes) ? saved.foes : [], dist: DISTS.includes(saved.dist) ? saved.dist : 30, sky: SKIES.includes(saved.sky) ? saved.sky : '', tac: saved.tac !== false, mmode: saved.mmode === '2v2' ? '2v2' : '1v1', mcap: MATCH_CAPS.includes(saved.mcap) ? saved.mcap : MATCH_CAPS[0],
    tab: ['match', 'tut'].includes(saved.tab) ? saved.tab : 'solo', mskill: saved.mskill === 'max' ? 'max' : 'esi', mroomf: ['1v1', '2v2'].includes(saved.mroomf) ? saved.mroomf : '', ptab: ['rec', 'mine', 'pub'].includes(saved.ptab) ? saved.ptab : 'rec', mpub: saved.mpub !== false,
    pfit: saved.pfit?.fit?.ship ? saved.pfit : null, pid: saved.pid || '', tutSel: typeof saved.tutSel === 'string' ? saved.tutSel : '',
    mode: ['ded', 'abyss'].includes(saved.mode) ? saved.mode : 'free', site: typeof saved.site === 'string' ? saved.site : '',
    allies: Array.isArray(saved.allies) ? saved.allies.filter((a) => a && Number(a.ship)).slice(0, 8).map((a) => ({ ship: Number(a.ship), fit: typeof a.fit === 'string' ? a.fit : 'kb', count: Math.max(1, Math.min(20, Number(a.count) || 1)) })) : [] });
  const hud = ctx.store.getJSON(HUD_KEY, null);
  if (hud && typeof hud === 'object') for (const k of Object.keys(HUD_DEF)) if (k in hud) S.hud[k] = hud[k] ? 1 : 0;
  for (const n of ['keydown', 'keyup']) document.addEventListener(n, onKey);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.pl-umenu, .pl-cmenu, [data-pl-hudopt]')) closeMenus(); }, true);
  window.addEventListener('blur', () => { S.keys.clear(); S.ctrl = false; cursorMode(); });
}
const save = () => ctx.store.setJSON(KEY, S.set);
// 预设场景：内置几个常见对局（我的船用击杀记录常见装配），玩家也能把当前设置存成自己的预设（存在本机）
const PRESET_KEY = 'eve-pilot-presets';
const PRESETS = [
  { id: 'p1', name: '护卫舰单挑', ship: 587, foes: [{ ship: 603, count: 1 }], dist: 10 },
  { id: 'p2', name: '巡洋舰打护卫舰小队', ship: 629, foes: [{ ship: 587, count: 3 }], dist: 10 },
  { id: 'p3', name: '被拦截舰缠住', ship: 621, foes: [{ ship: 11198, count: 2 }, { ship: 22456, count: 1 }], dist: 20 },
  { id: 'p4', name: '战巡对战巡', ship: 24702, foes: [{ ship: 24698, count: 1 }], dist: 30 },
  { id: 'p5', name: '战列舰被小船围攻', ship: 644, foes: [{ ship: 587, count: 3 }, { ship: 603, count: 3 }], dist: 20 },
  { id: 'p6', name: '无人机船对决', ship: 12005, foes: [{ ship: 17715, count: 1 }], dist: 30 },
  { id: 'p7', name: '战列舰对决', ship: 641, foes: [{ ship: 638, count: 1 }], dist: 50 },
];
const userPresets = () => { try { const l = ctx.store.getJSON(PRESET_KEY, []); return Array.isArray(l) ? l.filter((x) => x && x.ship && Array.isArray(x.foes)) : []; } catch { return []; } };
const sameFoes = (p) => p.foes.length === S.set.foes.length && p.foes.every((f, i) => f.ship === S.set.foes[i].ship && f.count === S.set.foes[i].count);
const sameAllies = (p) => { const a = p.allies || []; return a.length === S.set.allies.length && a.every((x, i) => x.ship === S.set.allies[i].ship && x.count === S.set.allies[i].count && (x.fit || 'kb') === S.set.allies[i].fit); };
const samePreset = (p) => p.ship === S.set.ship && (p.fit || 'kb') === S.set.fit && p.dist === S.set.dist && (p.sky ?? S.set.sky) === S.set.sky && sameFoes(p) && sameAllies(p);
function applyPreset(p) {
  Object.assign(S.set, { ship: p.ship, fit: p.fit || 'kb', foes: p.foes.map((f) => ({ ship: f.ship, count: f.count })), allies: (p.allies || []).map((a) => ({ ship: a.ship, fit: a.fit || 'kb', count: a.count })), dist: DISTS.includes(p.dist) ? p.dist : S.set.dist, pid: p.id || '' });
  if (p.fit === 'pub') { if (p.pfit) S.set.pfit = p.pfit; else S.set.fit = 'kb'; }
  if (p.sky != null && (p.sky === '' || SKIES.includes(p.sky))) S.set.sky = p.sky;
  save();
  renderSetup();
}
const presetTitle = () => `${shipsText(S.set)} 对 ${S.set.foes.map((f) => `${typeName(f.ship)}×${f.count}`).join('、')}`;
function savePreset() {
  const box = root.querySelector('[data-pl-pname]');
  const name = (box?.value || '').trim().slice(0, 40) || presetTitle();
  if (!S.set.foes.length) { ctx.showToast('先加至少一个敌人', 'error'); return; }
  const list = userPresets().filter((x) => x.name !== name);
  list.unshift({ id: 'u' + Date.now().toString(36), name, ship: S.set.ship, fit: S.set.fit, foes: S.set.foes.map((f) => ({ ship: f.ship, count: f.count })), allies: S.set.allies.map((a) => ({ ...a })), dist: S.set.dist, sky: S.set.sky, ...(S.set.fit === 'pub' ? { pfit: S.set.pfit } : {}) });
  ctx.store.setJSON(PRESET_KEY, list.slice(0, 30));
  ctx.showToast('已保存预设「' + name + '」', 'success');
  renderSetup();
}
function delPreset(id) {
  ctx.store.setJSON(PRESET_KEY, userPresets().filter((x) => x.id !== id));
  renderSetup();
}
// ---------- 玩家分享的预设（匹配服务存，server/match_service.mjs）：发布要绑定 EVE 角色，每人最多 10 个 ----------
const PUB = { list: null, busy: false, err: '', q: '', wait: null, me: 0 };
const canMatch = () => ctx.hasEsi?.() || (() => { try { return Boolean(localStorage.getItem('eve-match-dev')); } catch { return false; } })();
function loadPub() {
  if (PUB.busy) return;
  PUB.busy = true;
  PUB.err = '';
  fetchPresets().then((l) => { PUB.list = l; }).catch((e) => { PUB.err = e.message; }).finally(() => { PUB.busy = false; renderPresets(); });
  if (!PUB.me && ctx.hasEsi?.()) ctx.getEsiToken?.().then((t) => { PUB.me = Number(t?.character_id) || 0; renderPresets(); }).catch(() => {});
}
// 把我的一个预设公开：装配来源是本机的（我的装配 / 游戏装配 / 装配页当前）就把装配内容一起发上去
async function publishPreset(id) {
  const p = userPresets().find((x) => x.id === id);
  if (!p || PUB.wait) return;
  if (!canMatch()) { ctx.showToast('公开分享要先绑定 EVE 角色（ESI）', 'error'); return; }
  try {
    let fit = null;
    if (p.fit === 'hull') fit = 'hull';
    else if (p.fit === 'pub') fit = p.pfit?.fit || null;
    else if (p.fit && p.fit !== 'kb') { const f = await fitFor(p.ship, p.fit); if (f) fit = { ...ctx.normalize(f), name: f.name || '' }; }
    PUB.wait = p.name;
    renderPresets();
    if (!(await matchConnect(MH, () => ctx.getEsiToken()))) throw new Error(MT.err || '连不上服务器');
    PUB.me = MT.me?.id || PUB.me;
    matchSend({ op: 'preset_pub', p: { name: p.name, ship: p.ship, fit, foes: p.foes, allies: (p.allies || []).map((a) => ({ ship: a.ship, count: a.count, fit: a.fit === 'hull' ? 'hull' : 'kb' })), dist: p.dist, sky: p.sky ?? '' } });
  } catch (e) { PUB.wait = null; ctx.showToast(e.message, 'error'); renderPresets(); }
}
async function unpublishPreset(id) {
  if (PUB.wait || !confirm(tr('删除这个公开预设？'))) return;
  PUB.wait = id;
  if (!(await matchConnect(MH, () => ctx.getEsiToken()))) { PUB.wait = null; ctx.showToast(MT.err || '连不上服务器', 'error'); return; }
  matchSend({ op: 'preset_del', id });
}
async function usePub(id) {
  const p = PUB.list?.find((x) => x.id === id);
  if (!p) return;
  try {
    if (p.fit === 'fit') {
      const full = await fetchPreset(id);
      applyPreset({ ...full, fit: 'pub', pfit: { id, name: full.fit?.name || full.name, fit: full.fit } });
    } else applyPreset(p);
  } catch (e) { ctx.showToast(e.message, 'error'); }
}
const foesText = (p) => p.foes.map((f) => `${typeName(f.ship)}×${f.count}`).join('、');
const shipsText = (p) => [typeName(p.ship), ...(p.allies || []).map((a) => `${typeName(a.ship)}×${a.count}`)].join('、');
const presetInner = () => {
  const tab = S.set.ptab;
  const chip = (p, own) => `<span class="pl-preset${samePreset(p) ? ' on' : ''}"><button type="button" data-pl-preset="${esc(p.id)}" title="${esc(`${shipsText(p)} 对 ${foesText(p)} · ${p.dist} km`)}"><img src="${IMG(p.ship, 'icon', 32)}" alt="" loading="lazy">${esc(p.name)}</button>${own ? `<button type="button" class="x" data-pl-ppub="${esc(p.id)}" title="公开分享给其他玩家" aria-label="公开分享">${PUB.wait === p.name ? '…' : '分享'}</button><button type="button" class="x" data-pl-pdel="${esc(p.id)}" title="删除这个预设" aria-label="删除这个预设">×</button>` : ''}</span>`;
  const tabs = `<div class="segmented pl-ptabs" role="tablist">${[['rec', '推荐'], ['mine', '我的'], ['pub', '玩家分享']].map(([k, l]) => `<button type="button" role="tab" data-pl-ptab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  if (tab === 'mine') {
    const mine = userPresets();
    return `${tabs}<div class="pl-presets">${mine.map((p) => chip(p, true)).join('') || '<span class="text-muted">还没有保存过预设</span>'}</div>
      <div class="pl-psave"><input type="text" class="pi-input" maxlength="40" placeholder="预设名称" data-pl-pname><button type="button" class="btn btn-ghost btn-sm" data-pl-psave>保存当前设置</button></div>`;
  }
  if (tab === 'pub') {
    if (!PUB.list && !PUB.busy && !PUB.err) loadPub();
    return `${tabs}<div class="pl-psave"><input type="search" class="pi-input" placeholder="搜索名称、作者、船名" value="${esc(PUB.q)}" data-pl-pq autocomplete="off"><button type="button" class="btn btn-ghost btn-sm" data-pl-preload>刷新</button></div>
      <div class="pl-plist">${pubList()}</div>`;
  }
  return `${tabs}<div class="pl-presets">${PRESETS.map((p) => chip(p, false)).join('')}</div>`;
};
function pubList() {
  const me = MT.me?.id || PUB.me;
  const q = PUB.q.trim().toLowerCase();
  const list = (PUB.list || []).filter((p) => !q || [p.name, p.author, typeName(p.ship), ...p.foes.map((f) => typeName(f.ship))].some((x) => String(x).toLowerCase().includes(q)));
  const card = (p) => `<div class="pl-pcard${S.set.pid === p.id ? ' on' : ''}"><img src="${IMG(p.ship, 'icon', 64)}" alt="" loading="lazy">
      <div><b>${esc(p.name)}</b><span>${esc(typeName(p.ship))}${p.fit === 'fit' ? ` · ${esc(p.fitName || '自带装配')}` : ''}${(p.allies || []).length ? ` + ${esc(p.allies.map((a) => `${typeName(a.ship)}×${a.count}`).join('、'))}` : ''} 对 ${esc(foesText(p))} · ${p.dist} km</span><small translate="no">${esc(p.author)}</small></div>
      <button type="button" class="btn btn-ghost btn-sm" data-pl-puse="${esc(p.id)}">使用</button>${me && p.aid === me ? `<button type="button" class="btn btn-ghost btn-sm" data-pl-punpub="${esc(p.id)}">删除</button>` : ''}</div>`;
  return PUB.busy && !PUB.list ? '<p class="text-muted">正在读取…</p>' : PUB.err ? `<p class="pl-mt-err">${esc(PUB.err)}</p>` : list.map(card).join('') || `<p class="text-muted">${PUB.list?.length ? '没有符合的预设' : '还没有人分享预设'}</p>`;
}
function renderPresets() { const box = root?.querySelector('#plPresets'); if (box) box.innerHTML = presetInner(); }
// 查看装配：和战场模拟「装配详情」同一套内容（属性 + 按槽位的装备）；我的船按当前选的装配来源，敌人是击杀记录常见装配
const fitViews = new Map();
async function viewFit(who) {
  const foe = who.startsWith('f:') ? S.set.foes[Number(who.slice(2))] : null;
  const ally = who.startsWith('a:') ? S.set.allies[Number(who.slice(2))] : null;
  const ship = foe ? foe.ship : ally ? ally.ship : S.set.ship, key = foe ? 'kb' : ally ? ally.fit : S.set.fit;
  const k = ship + '|' + key;
  S.fitView = { k, ship, who, busy: !fitViews.has(k) };
  renderFitView();
  if (!fitViews.has(k)) {
    try {
      const fit = key === 'kb' ? null : await fitFor(ship, key);
      const r = await ctx.pilotRow(ship, fit ? ctx.normalize(fit) : null, fit?.name || '');
      fitViews.set(k, { row: r.row, label: r.row.label || fit?.name || '' });
    } catch (error) { fitViews.set(k, { error: error.message }); }
    if (S.fitView?.k === k) { S.fitView.busy = false; renderFitView(); }
  }
}
function renderFitView() {
  let box = root.querySelector('#plFitView');
  const v = S.fitView;
  if (!v) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.id = 'plFitView'; box.className = 'pl-fitview'; root.querySelector('#plSetup')?.append(box); }
  const d = fitViews.get(v.k);
  const body = v.busy ? '<p class="text-muted">正在计算装配…</p>' : d?.error ? `<p class="text-muted">${esc('装配算不出来：' + d.error)}</p>` : ctx.fitHtml ? ctx.fitHtml(d.row.fit, d.row.unit, true) : '';
  box.innerHTML = `<div class="pl-fitview-card" role="dialog" aria-label="查看装配">
    <div class="pl-fitview-head"><img src="${IMG(v.ship, 'icon', 64)}" alt="" width="40" height="40"><div><b>${esc(typeName(v.ship))}</b><small>${esc(v.who === 'me' ? '我的船' : v.who.startsWith('a:') ? '队友' : '敌人')}${d?.label ? ' · ' + esc(d.label) : ''}</small></div>
      ${!v.busy && d?.row && ctx.openInFitting ? '<button type="button" class="btn btn-ghost btn-sm" data-pl-fvopen title="在装配页打开这套装配，可以改装备后存成「我的装配」再来驾驶">在装配页打开</button>' : ''}
      <button type="button" class="btn btn-ghost btn-sm" data-pl-fvclose>关闭</button></div>
    <div class="pl-fitview-body">${body}</div></div>`;
}
// 船体面板选项（客户端 settings.user.ui：showPassiveModules 1、showEmptySlots 0、showReadout 0、readoutType 1（百分比）、
// showModuleTooltips 1、lockModules 0、lockOverload 0 —— 括号里是客户端的默认值）
const HUD_KEY = 'eve-pilot-hud';
const HUD_DEF = { passive: 1, empty: 0, readout: 0, pct: 1, tips: 1, lockMods: 0, lockOvl: 0 };
S.hud = { ...HUD_DEF };
const esc = (s) => ctx.esc(String(s ?? ''));
const typeName = (id) => ctx.data.types.get(id)?.name || '';
const flyShip = () => S.me?.r?.row.ship || S.set.ship;   // 正在开的船（练习里是固定的裂谷级）
const active = () => Boolean(root?.offsetParent) && !document.hidden;

// ---------- 游戏界面贴图 ----------
const TEX = {};
function tex(path) {
  if (!TEX[path]) { const im = new Image(); im.src = UI + path + '?v=1'; TEX[path] = im; }
  return TEX[path];
}
const ready = (im) => im && im.complete && im.naturalWidth > 0;
// 白色贴图染色（游戏里同一张贴图按状态上色）
const tinted = new Map();
function tint(path, color) {
  const im = tex(path);
  if (!ready(im)) return null;
  const k = path + color;
  if (!tinted.has(k)) {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    tinted.set(k, c);
  }
  return tinted.get(k);
}
const PRELOAD = ['classes/shipui/mainbgcircle.png', 'classes/shipui/mainunderlay.png', 'classes/shipui/gauge1.png', 'classes/shipui/gauge2.png', 'classes/shipui/gauge3.png',
  'classes/target/targetbackground.png',
  'classes/target/shieldleft.png', 'classes/target/shieldright.png', 'classes/target/armorleft.png', 'classes/target/armorright.png', 'classes/target/hullleft.png', 'classes/target/hullright.png',
  'classes/target/timerleft.png', 'classes/target/timerright.png', 'classes/target/spincorners.png', 'classes/target/selectedtargeteditem.png', 'classes/target/shipmask.png',
  'classes/bracket/shiptarget.png', 'classes/bracket/activetarget.png', 'classes/bracket/selectioncircle.png', 'classes/bracket/targetframe.png',
  'classes/shipui/slotmaincombined.png', 'classes/shipui/slotglow.png', 'classes/shipui/capacitorcellglow.png', 'classes/shipui/capacitorcell_2.png', 'classes/shipui/gaugefill.png',
  'classes/shipui/speedounderlay.png', 'classes/shipui/speedooverlay_v2.png', 'classes/shipui/heatgaugeneedle.png', 'classes/shipui/heatdivider.png', 'classes/shipui/lowheat_0.png',
  'classes/shipui/medheat_0.png', 'classes/shipui/hiheat_0.png', 'classes/shipui/slotrampleft.png', 'classes/shipui/slotrampright.png', 'classes/shipui/slothilite.png',
  'classes/shipui/slotoverloaddisabled.png', 'classes/shipui/slotquantityunderlay.png'];

// ---------- 页面 ----------
export function mountPilot(el) {
  const fresh = root !== el;
  root = el;
  PRELOAD.forEach(tex);
  if (fresh) {
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('pointerdown', onWinPointer);
    // 画面大小变了：按各窗口自己的原位置重新夹进画面（不改原位置，画面变回来窗口也回原处）
    new ResizeObserver(() => { for (const w of el.querySelectorAll('[data-win]')) if (!w.hidden) moveWin(w, Number(w.dataset.hx ?? w.offsetLeft), Number(w.dataset.hy ?? w.offsetTop), true); }).observe(el);
  }
  if (S.b && el.querySelector('#plStage')) { startLoop(); return; }
  if (!S.set.ship) {
    const cur = ctx.getFit?.();
    S.set.ship = cur?.ship || 587;   // 默认：装配页当前的船，没有就用 Rifter
  }
  if (!S.set.foes.length) S.set.foes = [{ ship: S.set.ship, count: 1 }];
  renderSetup();
  // 刷新前在对局里：连上服务器，服务器会把对局接回来
  let live = null;
  try { live = sessionStorage.getItem(LIVE_KEY); } catch { /* 隐私模式 */ }
  if (live && MT.state === 'off') matchConnect(MH, () => ctx.getEsiToken()).then((ok) => setTimeout(() => { if (!S.match) { try { sessionStorage.removeItem(LIVE_KEY); } catch { /* 隐私模式 */ } } }, ok ? 4000 : 0));
}

// 出发前的设置：我的船（装配来源）、敌人、开局距离
function fitChoices(ship) {
  const out = [['kb', '击杀记录常见装配']];
  const cur = ctx.getFit?.();
  if (cur?.ship === ship) out.push(['current', '装配页当前装配']);
  for (const f of ctx.savedFits().filter((x) => x.ship === ship)) out.push(['saved:' + f.id, '我的装配 · ' + (f.name || '未命名')]);
  for (const f of (S.esiFits || []).filter((x) => x.ship === ship)) out.push(['esi:' + f.esiId, '游戏装配 · ' + (f.name || '未命名')]);
  if (S.set.pfit?.fit?.ship === ship) out.push(['pub', '分享的装配 · ' + (S.set.pfit.name || '未命名')]);
  out.push(['hull', '空船（无装备）']);
  return out;
}
// 设置页整页重画（innerHTML）时保住滚动位置：页面和 root 外层可滚动的容器都记下来，画完还原（不然选船、改装配会跳回网页顶部）
function keepScroll(fn) {
  const els = [document.scrollingElement || document.documentElement];
  for (let e = root?.parentElement; e && e !== document.body; e = e.parentElement) if (e.scrollHeight > e.clientHeight) els.push(e);
  const pos = els.map((e) => [e, e.scrollTop, e.scrollLeft]);
  // 设置页自己就是滚动容器（#plSetup 和里面的窗口），会被整个换掉：按选择器记，画完找新的那个还原
  const inner = ['#plSetup', '#plSetup .pl-win'].map((q) => { const e = root.querySelector(q); return e ? [q, e.scrollTop] : null; }).filter(Boolean);
  fn();
  const back = () => {
    for (const [e, t, l] of pos) if (e.scrollTop !== t || e.scrollLeft !== l) { e.scrollTop = t; e.scrollLeft = l; }
    for (const [q, t] of inner) { const e = root.querySelector(q); if (e && e.scrollTop !== t) e.scrollTop = t; }
  };
  back();
  requestAnimationFrame(back);   // 图片等撑开高度后再还原一次
}
function renderSetup() {
  if (root?.querySelector('#plSetup')) return keepScroll(renderSetupNow);
  renderSetupNow();
}
function renderSetupNow() {
  stopLoop();
  disposeView();
  if (S.envSave) { ctx.FE.setEnv(S.envSave); S.envSave = null; }
  const ship = S.set.ship;
  const fits = fitChoices(ship);
  if (!fits.some(([k]) => k === S.set.fit)) S.set.fit = 'kb';
  if (ctx.hasEsi?.() && !S.esiFits && !S.esiLoading) {
    S.esiLoading = true;
    ctx.esiFits().then((l) => { S.esiFits = l; }).catch(() => { S.esiFits = []; }).finally(() => { S.esiLoading = false; if (root.querySelector('#plSetup')) renderSetup(); });
  }
  const tab = S.set.tab;
  const meField = `<div class="pl-field">
          <label>我的船</label>
          <div class="pl-ship">${shipChip(ship)}<button type="button" class="btn btn-ghost btn-sm" data-pl-view="me">查看装配</button><div class="pl-search"><input type="search" class="pi-input" placeholder="搜索船名换一艘" data-pl-q="me" autocomplete="off"><div class="pl-results" data-pl-res="me" hidden></div></div></div>
          <select class="plain-select" data-pl-fit>${fits.map(([k, l]) => `<option value="${esc(k)}"${k === S.set.fit ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div>`;
  const fitSel = (sh, cur, attr) => `<select class="plain-select" ${attr}>${fitChoices(sh).map(([k, l]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  // 我方：自己驾驶的那艘 + 队友（AI，各自选装配来源）；点「驾驶」换成开那一艘
  const sideField = `<div class="pl-field">
          <label>我方</label>
          <div class="pl-foes">
            <div class="pl-ally on"><div class="pl-foe">${shipChip(ship)}<span class="pl-drive">驾驶中</span><button type="button" class="btn btn-ghost btn-sm" data-pl-view="me">查看装配</button>${S.set.allies.length ? '<button type="button" class="btn btn-ghost btn-sm" data-pl-mdel>移除</button>' : ''}</div>${fitSel(ship, S.set.fit, 'data-pl-fit')}</div>
            ${S.set.allies.map((a, i) => `<div class="pl-ally"><div class="pl-foe">${shipChip(a.ship)}<input type="number" class="pi-input" min="1" max="20" value="${a.count}" data-pl-acount="${i}" aria-label="数量"><button type="button" class="btn btn-ghost btn-sm" data-pl-drive="${i}">改为驾驶</button><button type="button" class="btn btn-ghost btn-sm" data-pl-view="a:${i}">查看装配</button><button type="button" class="btn btn-ghost btn-sm" data-pl-adel="${i}">移除</button></div>${fitSel(a.ship, a.fit, `data-pl-afit="${i}"`)}</div>`).join('')}
          </div>
          <div class="pl-search"><input type="search" class="pi-input" placeholder="搜索船名加队友" data-pl-q="ally" autocomplete="off"><div class="pl-results" data-pl-res="ally" hidden></div></div>
        </div>`;
  const mode = S.set.mode;
  const modeSeg = `<div class="pl-field pl-span"><label>模式</label><div class="segmented" role="group" aria-label="模式">${[['free', '自由对战'], ['ded', '死亡空间'], ['abyss', '深渊']].map(([k, l]) => `<button type="button" data-pl-mode="${k}" class="${mode === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>`;
  const siteGrid = `<div class="pl-setup-grid">
        ${modeSeg}
        <div class="pl-field pl-span"><label>${mode === 'abyss' ? '深渊' : '复合体'}</label><div id="plSites">${S.npcReady ? ST.siteSetupHtml(mode, S.set.site, S.set.abyWx) : '<p class="text-muted">正在加载 NPC 数据…</p>'}</div></div>
        ${sideField}
      </div>
      <div class="pl-setup-foot"><button type="button" class="btn btn-primary" data-pl-go${S.loading || !S.npcReady ? ' disabled' : ''}>${S.loading ? '准备中…' : '起飞'}</button></div>`;
  if (mode !== 'free' && !S.npcReady) ST.loadNpcData().then((d) => { S.npcReady = Boolean(d); if (!d) ctx.showToast('NPC 数据加载失败', 'error', 4000); if (root.querySelector('#plSetup')) renderSetup(); });
  const solo = mode !== 'free' ? siteGrid : `<div class="pl-setup-grid">
        ${modeSeg}
        <div class="pl-field pl-span"><label>预设场景</label><div id="plPresets">${presetInner()}</div></div>
        ${sideField}
        <div class="pl-field">
          <label>敌人</label>
          <div class="pl-foes">${S.set.foes.map((f, i) => `<div class="pl-foe">${shipChip(f.ship)}<input type="number" class="pi-input" min="1" max="20" value="${f.count}" data-pl-count="${i}" aria-label="数量"><button type="button" class="btn btn-ghost btn-sm" data-pl-view="f:${i}">查看装配</button><button type="button" class="btn btn-ghost btn-sm" data-pl-del="${i}">移除</button></div>`).join('') || '<p class="text-muted">还没有敌人</p>'}</div>
          <div class="pl-search"><input type="search" class="pi-input" placeholder="搜索船名加敌人" data-pl-q="foe" autocomplete="off"><div class="pl-results" data-pl-res="foe" hidden></div></div>
        </div>
        <div class="pl-field">
          <label>开局距离</label>
          <div class="segmented" role="group" aria-label="开局距离">${DISTS.map((d) => `<button type="button" data-pl-dist="${d}" class="${S.set.dist === d ? 'active' : ''}">${d} km</button>`).join('')}</div>
        </div>
        <div class="pl-field">
          <label>星空</label>
          <div class="segmented" role="group" aria-label="星空">${Object.entries(SKY_NAME).map(([k, l]) => `<button type="button" data-pl-sky="${k}" class="${S.set.sky === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        </div>
      </div>
      <div class="pl-setup-foot"><button type="button" class="btn btn-primary" data-pl-go${S.loading ? ' disabled' : ''}>${S.loading ? '准备中…' : '起飞'}</button></div>`;
  // 大厅布局：左边房间列表（筛选 + 表格 + 邀请码），右边我的出战（船、规则、快速匹配、开房间）
  const match = `<div class="pl-lobby">
        <section class="pl-lobby-main">
          <div class="pl-lobby-head"><h4>公开房间</h4>
            <div class="segmented" role="group" aria-label="模式筛选">${[['', '全部'], ['1v1', '1v1'], ['2v2', '2v2']].map(([k, l]) => `<button type="button" data-pl-mrf="${k}" class="${S.set.mroomf === k ? 'active' : ''}">${l}</button>`).join('')}</div>
            <span class="pl-lobby-sp"></span>
            <input type="text" class="pi-input pl-mt-in" maxlength="6" placeholder="输入邀请码" data-pl-mcode autocomplete="off" spellcheck="false"><button type="button" class="btn btn-ghost btn-sm" data-pl-mj>加入房间</button>
          </div>
          <div class="pl-rtable">
            <div class="pl-rrow pl-rhead"><span>房主</span><span>模式</span><span>舰船级别</span><span>价值上限</span><span>技能</span><span>人数</span><span></span></div>
            <div id="plRooms">${roomsInner()}</div>
          </div>
        </section>
        <aside class="pl-lobby-side">
          ${meField}
          <div class="pl-field" id="plMatch">${matchInner()}</div>
        </aside>
      </div>`;
  root.innerHTML = `<div class="pl-page"><section class="pl-setup" id="plSetup">
    <div class="pl-win pl-w pl-big">
      <div class="pl-win-head"><h3>驾驶模拟</h3><div class="segmented pl-tabs" role="tablist">${[['solo', '单人'], ['tut', '练习'], ['match', '匹配对战']].map(([k, l]) => `<button type="button" role="tab" data-pl-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      ${tab === 'match' ? match : tab === 'tut' ? tutListHtml(S.set.tutSel, S.loading) : solo}
    </div>
  </section></div>`;
  if (tab === 'match') matchTab();
  if (S.fitView) renderFitView();
}
// 换成驾驶第 i 个队友（原来开的船变成队友）
function driveAlly(i) {
  const a = S.set.allies[i];
  if (!a) return;
  const old = { ship: S.set.ship, fit: S.set.fit, count: 1 };
  if (a.count > 1) { a.count--; S.set.allies.splice(i, 0, old); } else S.set.allies[i] = old;
  Object.assign(S.set, { ship: a.ship, fit: a.fit });
  // 同船同装配的队友合成一行
  S.set.allies = S.set.allies.reduce((l, x) => { const y = l.find((z) => z.ship === x.ship && z.fit === x.fit); if (y) y.count = Math.min(20, y.count + x.count); else l.push({ ...x }); return l; }, []);
  save();
  renderSetup();
}
const shipChip = (id) => `<span class="pl-chip"><img src="${IMG(id, 'icon', 32)}" alt="" loading="lazy"><b>${esc(typeName(id))}</b></span>`;

function onInput(e) {
  if (SC.scanInput(e)) return;
  const q = e.target.closest('[data-pl-q]');
  if (e.target.matches('[data-pl-pq]')) {
    PUB.q = e.target.value;
    const box = root.querySelector('.pl-plist');
    if (box) box.innerHTML = pubList();
    return;
  }
  if (q) {
    const box = root.querySelector(`[data-pl-res="${q.dataset.plQ}"]`);
    const list = q.value.trim() ? ctx.shipSearch(q.value.trim()) : [];
    box.hidden = !list.length;
    box.innerHTML = list.map((t) => `<button type="button" data-pl-pick="${q.dataset.plQ}:${t.id}"><img src="${IMG(t.id, 'icon', 32)}" alt="" loading="lazy">${esc(t.name)}</button>`).join('');
  }
}
function onChange(e) {
  const t = e.target;
  if (FL.fleetChange(e) || SC.scanChange(e)) return;
  if (t.matches('[data-pl-fit]')) { S.set.fit = t.value; save(); }
  if (t.matches('[data-pl-afit]')) { const a = S.set.allies[Number(t.dataset.plAfit)]; if (a) { a.fit = t.value; save(); } }
  if (t.matches('[data-pl-acount]')) { const a = S.set.allies[Number(t.dataset.plAcount)]; if (a) { a.count = Math.max(1, Math.min(20, Math.round(Number(t.value)) || 1)); save(); } }
  if (t.matches('[data-pl-count]')) { const f = S.set.foes[Number(t.dataset.plCount)]; if (f) { f.count = Math.max(1, Math.min(20, Math.round(Number(t.value)) || 1)); save(); } }
}

// ---------- 起飞 ----------
async function fitFor(ship, key) {
  if (key === 'current') return ctx.getFit();
  if (key === 'pub') return S.set.pfit?.fit?.ship === ship ? S.set.pfit.fit : null;
  if (key === 'hull') return { id: null, name: '', ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
  if (key.startsWith('saved:')) return ctx.savedFits().find((x) => String(x.id) === key.slice(6)) || null;
  if (key.startsWith('esi:')) return (S.esiFits || []).find((x) => String(x.esiId) === key.slice(4)) || null;
  return null;   // 常见装配
}
async function launch() {
  if (S.loading) return;
  if (S.set.mode !== 'free') { launchSite(); return; }
  S.tut = null;
  tutStop();
  S.loading = true;
  S.fitView = null;
  renderSetup();
  try {
    const fit = await fitFor(S.set.ship, S.set.fit);
    const mine = await ctx.pilotRow(S.set.ship, fit ? ctx.normalize(fit) : null, fit?.name || '', { self: true });
    S.fitLabel = mine.row.label || fit?.name || '';
    if (!mine.row.unit) throw new Error('这个装配算不出属性');
    // 同型敌人只算一次装配
    const foes = [];
    const cache = new Map();
    for (const f of S.set.foes) {
      if (!cache.has(f.ship)) cache.set(f.ship, ctx.pilotRow(f.ship));
      const r = await cache.get(f.ship);
      if (r.row.unit) foes.push({ ...r.row, id: 'f' + foes.length, count: f.count });
    }
    if (!foes.length) throw new Error('先加至少一个敌人');
    // 队友：同型同装配只算一次
    const allies = [];
    for (const a of S.set.allies) {
      const k = a.ship + '|' + a.fit;
      if (!cache.has(k)) cache.set(k, (async () => { const f = a.fit === 'kb' ? null : await fitFor(a.ship, a.fit); return ctx.pilotRow(a.ship, f ? ctx.normalize(f) : null, f?.name || ''); })());
      const r = await cache.get(k);
      if (r.row.unit) allies.push({ ...r.row, id: 'a' + allies.length, count: a.count });
    }
    await loadSys();
    S.loading = false;
    start(mine, foes, allies);
  } catch (error) {
    S.loading = false;
    renderSetup();
    ctx.showToast('起飞失败：' + error.message, 'error', 4000);
  }
}
// 场景（pilot-site.js）：死亡空间复合体 / 深渊。没有开局敌人，进房间按刷怪表刷 NPC；深渊没有天体
async function launchSite() {
  const base = ST.siteById(S.set.site) || ST.siteById(ST.siteDefault(S.set.mode));
  if (!base) return;
  // 深渊：先读战利品表（抽实跑要用），再生成这一趟的房间
  if (base.kind === 'abyss') await ST.loadLoot();
  const def = ST.siteInstance(base, S.set.abyWx);
  if (!def) return;
  S.tut = null;
  tutStop();
  S.loading = true;
  S.fitView = null;
  renderSetup();
  try {
    await ST.loadNpcData();
    // 舰船限制：深渊巡洋舰版只能 1 艘巡洋舰（不含 T3 战略巡洋）；死亡空间不允许旗舰
    const grp = ctx.data.types.get(S.set.ship)?.group;
    if (def.allow && !def.allow.includes(grp)) throw new Error('深渊（巡洋舰）只允许巡洋舰进入，不含战略巡洋舰');
    if (def.deny?.includes(grp)) throw new Error('这个复合体不允许旗舰进入');
    if (def.solo && S.set.allies.length) throw new Error('深渊（巡洋舰）只能 1 艘船进入，先移除队友');
    // 天气：深渊天气对玩家的加成走装配计算的环境效果（和装配页的天象同一套），飞完还原
    S.envSave = ctx.FE.getEnv().slice();
    ctx.FE.setEnv(def.kind === 'abyss' && def.weather ? [def.weather] : []);
    const fit = await fitFor(S.set.ship, S.set.fit);
    const mine = await ctx.pilotRow(S.set.ship, fit ? ctx.normalize(fit) : null, fit?.name || '', { self: true });
    S.fitLabel = mine.row.label || fit?.name || '';
    if (!mine.row.unit) throw new Error('这个装配算不出属性');
    const allies = [], cache = new Map();
    for (const a of S.set.allies) {
      const k = a.ship + '|' + a.fit;
      if (!cache.has(k)) cache.set(k, (async () => { const f = a.fit === 'kb' ? null : await fitFor(a.ship, a.fit); return ctx.pilotRow(a.ship, f ? ctx.normalize(f) : null, f?.name || ''); })());
      const r = await cache.get(k);
      if (r.row.unit) allies.push({ ...r.row, id: 'a' + allies.length, count: a.count });
    }
    await loadSys();
    S.loading = false;
    start(mine, [], allies, { dist: 0, cel: def.kind === 'abyss' ? [] : null, sky: def.sky, msg: def.kind === 'abyss' ? '已进入深渊空间' : '已到达复合体入口', site: true });
    S.b.hold = true;   // 敌人打光了也不结束，由场景判定（清完最后一个房间 / 起源导管）
    ST.siteStart(def);
    for (let i = S.names.length; i < S.b.units.length; i++) S.names.push(typeName(S.b.units[i].r.row.ship));
  } catch (error) {
    S.loading = false;
    if (S.envSave) { ctx.FE.setEnv(S.envSave); S.envSave = null; }
    renderSetup();
    ctx.showToast('起飞失败：' + error.message, 'error', 4000);
  }
}
// 深渊导管：画面闪一下白（客户端过导管是一段跃迁隧道动画，这里简化成淡入淡出）
function siteFade() {
  const stage = root?.querySelector('#plStage');
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'pl-fade';
  stage.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}
// 练习（pilot-tutor.js）：固定的船和装配，训练目标只有船体
const hullFit = (ship) => ({ id: null, name: '', ship, slots: { high: [], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] });
async function launchTut(id) {
  const sp = tutSpec(id);
  if (!sp || S.loading) return;
  S.tut = id;
  tutStop();
  S.loading = true;
  S.fitView = null;
  renderSetup();
  try {
    const mine = await ctx.pilotRow(sp.fit.ship, ctx.normalize(sp.fit), '练习', { self: true });
    S.fitLabel = '练习';
    if (!mine.row.unit) throw new Error('这个装配算不出属性');
    // 训练目标：只有船体（同型共用一份）；会还手的敌船带自己的装配
    // ally: true 的是队友（和我同一边）
    const foes = [], allies = [], cache = new Map();
    for (const [k, x] of sp.targets.entries()) {
      const key = x.fit ? 'f' + k : x.ship;
      if (!cache.has(key)) cache.set(key, ctx.pilotRow(x.ship, ctx.normalize(x.fit || hullFit(x.ship)), x.ally ? '队友' : '训练目标'));
      const r = await cache.get(key);
      if (r.row.unit) (x.ally ? allies : foes).push({ ...r.row, id: (x.ally ? 'a' : 'f') + k, count: 1 });
    }
    await loadSys();
    S.loading = false;
    start(mine, foes, allies, { dist: 20, msg: '开始练习', fleet: sp.L.fleet?.virt ? { virt: sp.L.fleet.virt } : null });
    S.b.hold = true;   // 敌船打光了也不结束（后面可能还有步骤），由练习判定结束
    // 武器编成一组（游戏里装上同型武器时会提示编组），F1 一起开
    const g = (S.on.guns || []).map((x) => x.m);
    if (g.length > 1) { R.setGroups([[g[0], g.slice(1)]]); renderRack(); }
    tutBegin(id);
  } catch (error) {
    S.loading = false;
    S.tut = null;
    renderSetup();
    ctx.showToast('起飞失败：' + error.message, 'error', 4000);
  }
}
function start(mine, foes, allies = [], o = {}) {
  S.match = null;
  S.site = o.site ? {} : null;   // 场景：先占个位（窗口按它决定开不开），进画面后 siteStart 填上
  S.siteEnd = null;
  S.envFx = null;
  S.jumpFx?.cancel();
  S.jumpFx = null;
  R = RL;
  RL.setRand(Math.random);
  const me = { ...mine.row, id: 'me', count: 1 };
  me.unit = R.prep(mine);
  // 星空先定下来：天体（星系）跟着星空走
  S.sky = o.sky || (SKIES.includes(S.set.sky) ? S.set.sky : SKIES[Math.floor(Math.random() * SKIES.length)]);
  const b = createBattle({ A: [me, ...allies], B: foes }, { cel: o.cel || celOf(SYS?.systems?.[S.sky], SYS?.types, window.I18N?.lang === 'en' ? SYS?.typesEn : null), dist: o.dist ?? S.set.dist, moveA: 'orbit', moveB: 'orbit', focus: 'weak', logi: true, ewar: true, cap: true, max: 3600, record: true, droneUnits: true, seed: (Math.random() * 2 ** 31) | 0, onHit: logHit, onDrain: logDrain });
  S.b = b;
  const calc = mine.row.calc;
  const maxLocks = Math.max(1, Math.min(calc?.ship?.attr(192) || 5, calc?.char?.attr(192) || 5));
  R.bind(0, maxLocks);
  // 玩家放在 A 方出发点，开局对着敌人
  S.names = b.units.map((u, i) => (i === 0 ? tr('我') : `${typeName(u.r.row.ship)} ${b.units.filter((x, k) => k <= i && x.r === u.r).length}`));
  FL.fleetReset(o.fleet || {});
  rackInit();
  enter(o.msg || `${typeName(S.set.ship)} 已就位，敌人在 ${S.set.dist} km 外`);
}
// 进入飞行画面（单机、匹配共用）
function enter(msg) {
  Object.assign(S, { t: S.b.t, paused: false, sel: -1, log: [], killN: S.b.kills.length, lastAct: S.me?.pilot?.active || null, logAt: 0, ended: false, ovAt: 0 });
  const pref = Math.round((S.on.pref || 5000) / 500) * 500;
  S.orbit = S.orbit || Math.min(pref, 20000);
  S.keep = S.keep || pref;
  SC.scanReset();
  CG.cargoInit(S.calc);
  loadBrk();
  loadShipIndex().then((ix) => { S.brk = S.b ? S.b.units.map((u) => ix?.types?.[u.r.row.ship]?.b || 'frigate') : []; renderOverview(true); });
  renderStage();
  pushLog(msg, 'sys');
}

// 总览图标：游戏的 16 像素舰船类别图标；无人机、舰载机、残骸用战场模拟的图标
const CCP_BRK = new Set(['frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'carrier', 'dreadnought', 'titan', 'industrial', 'capsule', 'shuttle', 'rookie', 'miningbarge', 'freighter', 'forceauxiliary', 'supercarrier', 'industrialcommand', 'miningfrigate']);
const brkSrc = (b) => (CCP_BRK.has(b) ? `${UI}shared/brackets/${b}_16.png?v=1` : `assets/brackets/${b}.png?v=1`);
// 游戏的图标对照表（tools/ui-assets/brackets.py 从客户端 staticdata/brackets*.static 解出）：
// 照 bracketMgr.GetBracketIcon —— 先按 typeID，没有再按 groupID、categoryID → 图标贴图
let BRK = null, brkLoad = null;
const loadBrk = () => (brkLoad ||= fetch(`${UI}brackets.json?v=1`).then((r) => (r.ok ? r.json() : null)).then((d) => {
  BRK = d;
  const body = root?.querySelector('#plOv');
  if (body) body.textContent = '';
  renderOverview();
}).catch(() => null));
function brkPath(type) {
  if (!BRK) return null;
  const t = ctx.data.types.get(type);
  const id = BRK.type[type] ?? (t && BRK.group[t.group]) ?? (t && BRK.category[t.category]);
  const p = id != null ? BRK.icon[id] : null;
  return p && p !== 'none' ? p : null;
}
const typeIcon = (type, fb) => { const p = brkPath(type); return p ? `${UI}${p}?v=1` : brkSrc(fb); };

// ---------- 窗口（像游戏里一样：拖标题栏移动、拖右下角缩放、最小化、关闭，左侧 Neocom 重新打开；位置记在本机）----------
// 默认位置按画面大小算：r = 离右边，b = 离下边
const WINS = [
  { id: 'ctl', title: '模拟控制', icon: 'settings', w: 300, h: 74, x: 56, y: 10 },
  { id: 'sel', title: '选中的物体', icon: 'info', w: 400, h: 168, r: 10, y: 10, nokill: true },
  { id: 'ov', title: '总览', icon: 'overview', w: 400, h: 330, r: 10, y: 186, nokill: true },
  { id: 'drones', title: '无人机', icon: 'drones', w: 400, h: 216, r: 10, y: 524, nokill: true, need: () => S.on?.drones?.length > 0 },
  { id: 'ship', title: '舰船属性', icon: 'fitting', w: 270, h: 300, x: 56, y: 96, closed: true },
  // 场景（死亡空间 / 深渊）：当前房间、深渊计时、天气
  { id: 'site', title: '地点', icon: 'info', w: 300, h: 140, x: 56, y: 96, need: () => Boolean(S.site) },
  { id: 'log', title: '日志', icon: 'log', w: 420, h: 200, x: 56, y: 410, closed: true },
  // 货柜舱（客户端库存窗口，列表视图）；残骸货柜（打开残骸时弹出，标题换成残骸名）
  { id: 'cargo', title: '货柜舱', ico: 'windowicons/cargo.png', w: 440, h: 260, x: 340, y: 96, closed: true },
  { id: 'loot', title: '货柜', ico: 'windowicons/cargocontainer.png', w: 440, h: 240, x: 340, y: 370, closed: true, need: () => S.set.mode === 'abyss' && !S.match && !S.tut },
  // 舰队（有队友时才有）：舰队窗口、单独拖出来的广播窗口、关注列表
  { id: 'fleet', title: '舰队', icon: 'fleet', w: 300, h: 300, x: 56, y: 400, more: true, need: () => FL.fleetOn() },
  { id: 'bc', title: '广播', icon: 'fleet', w: 300, h: 220, x: 362, y: 480, need: () => FL.fleetOn() },
  { id: 'watch', title: '关注列表', icon: 'fleet', w: 240, h: 150, r: 420, y: 10, closed: true, need: () => FL.fleetOn() },
  { id: 'fcomp', title: '舰队编制', icon: 'fleet', w: 560, h: 300, x: 380, y: 120, closed: true, need: () => FL.fleetOn() },
  // 扫描器（客户端窗口默认大小：定向 400×350、探针 400×400；探针扫描器上面多了一张小星系图，加高）
  { id: 'dscan', title: '定向扫描器', ico: 'eveicon/product_icons/directional_scanner_64px.png', w: 400, h: 350, r: 420, y: 170, closed: true },
  { id: 'probe', title: '探针扫描器', ico: 'eveicon/product_icons/probe_scanner_64px.png', w: 1000, h: 600, x: 330, y: 60, closed: true }
];
const winIcon = (w) => (w.ico ? `${UI}${w.ico}?v=1` : `${UI}windowicons/${w.icon}.png?v=1`);
const WIN_KEY = 'eve-pilot-wins';
const winBody = {
  ctl: () => `<div class="pl-ctl"><button type="button" class="pl-btn" data-pl-exit>返回设置</button>${S.match ? '' : '<button type="button" class="pl-btn" data-pl-pause>暂停</button><button type="button" class="pl-btn" data-pl-restart>重来</button>'}<button type="button" class="pl-btn" data-pl-full>${document.fullscreenElement ? '退出全屏' : '全屏'}</button><span class="pl-clock" id="plClock"></span></div>`,
  sel: () => '<div id="plSel"></div>',
  ov: () => `<div class="pl-ov-tabs">${OV_TABS.map(([n, , c], i) => `<button type="button" data-pl-ovtab="${i}" style="--c:${c}"${i === S.ovTab ? ' class="on"' : ''}>${n}</button>`).join('')}<i class="pl-ov-line"></i></div><div class="pl-ov-body"><table style="width:${ovCols().reduce((a, b) => a + b, 0)}px"><colgroup>${ovCols().map((w) => `<col style="width:${w}px">`).join('')}</colgroup><thead><tr><th></th><th class="srt">距离<img src="${UI}eveicon/system_icons/caret_up_16px.png?v=1" alt=""><i class="pl-ovsc" data-ov-scale="1"></i></th><th>名字<i class="pl-ovsc" data-ov-scale="2"></i></th><th>类型<i class="pl-ovsc" data-ov-scale="3"></i></th><th>速度 (m/s)<i class="pl-ovsc" data-ov-scale="4"></i></th></tr></thead><tbody id="plOv"></tbody></table></div>`,
  drones: () => '<div id="plDrones"></div>',
  ship: () => '<div id="plShip"></div>',
  site: () => '<div id="plSite"></div>',
  log: () => '<div class="pl-log" id="plLog"></div>',
  cargo: () => CG.cargoBody(),
  loot: () => CG.lootBody(),
  fleet: () => FL.fleetBody(),
  bc: () => FL.bcBody(),
  watch: () => FL.watchBody(),
  fcomp: () => FL.compBody(),
  dscan: () => SC.dsBody(),
  probe: () => SC.psBody()
};
function winLayout() {
  let saved = {};
  try { saved = ctx.store.getJSON(WIN_KEY, {}) || {}; } catch { /* 默认 */ }
  // 探针扫描器改成「星系图 + 面板」后窗口变宽：旧版存下来的窄尺寸不用
  if (saved.probe && saved.probe.w < 700) { delete saved.probe.w; delete saved.probe.h; }
  return saved;
}
function saveWins() {
  const out = {};
  for (const el of root.querySelectorAll('[data-win]')) {
    out[el.dataset.win] = { x: Number(el.dataset.hx ?? el.offsetLeft), y: Number(el.dataset.hy ?? el.offsetTop), w: el.offsetWidth, h: el.classList.contains('min') ? Number(el.dataset.h) || el.offsetHeight : el.offsetHeight, open: !el.hidden, min: el.classList.contains('min'), lock: el.classList.contains('locked') };
  }
  ctx.store.setJSON(WIN_KEY, out);
}
const WIN_RS = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];
// 总览列宽（客户端 SortHeaders：图标列固定 22，其他列最小 COLUMNMINSIZE = 24，按页签分别记住）
const OVCOL_KEY = 'eve-pilot-ovcols', OVCOL_DEF = [22, 80, 112, 112, 58], OVCOL_MIN = 24;
function ovCols() {
  let all = {};
  try { all = ctx.store.getJSON(OVCOL_KEY, {}) || {}; } catch { /* 默认 */ }
  const c = all[S.ovTab ?? 0];
  return OVCOL_DEF.map((d, k) => (k === 0 ? d : Math.max(OVCOL_MIN, Number(c?.[k]) || d)));
}
function saveOvCols(ws) {
  let all = {};
  try { all = ctx.store.getJSON(OVCOL_KEY, {}) || {}; } catch { /* 默认 */ }
  all[S.ovTab ?? 0] = ws;
  ctx.store.setJSON(OVCOL_KEY, all);
}
function applyOvCols(ws = ovCols()) {
  const cols = root.querySelectorAll('.pl-ov-body col');
  ws.forEach((w, k) => { if (cols[k]) cols[k].style.width = w + 'px'; });
  const tb = root.querySelector('.pl-ov-body table');
  if (tb) tb.style.width = ws.reduce((a, b) => a + b, 0) + 'px';
}
// 拖表头右边的条改列宽：width = max(最小, 起始宽 + 位移)
function onOvScale(e, h) {
  e.preventDefault();
  e.stopPropagation();
  const k = Number(h.dataset.ovScale), ws = ovCols(), w0 = ws[k], x0 = e.clientX;
  h.classList.add('on');
  const move = (ev) => { ws[k] = Math.max(OVCOL_MIN, Math.round(w0 + ev.clientX - x0)); applyOvCols(ws); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); h.classList.remove('on'); saveOvCols(ws); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
// 双击表头：这一列按最宽的内容收放（客户端 OnColumnSizeReset：max(文字宽) + 左右各 8）
let ovMeasure;
function ovAutoFit(k) {
  if (k <= 0) return;
  ovMeasure = ovMeasure || document.createElement('canvas').getContext('2d');
  ovMeasure.font = '12px "EVE Sans Neue", system-ui, sans-serif';
  let w = OVCOL_MIN - 16;
  for (const tr of root.querySelectorAll('#plOv tr[data-k]:not(.none)')) {
    const c = tr.cells[k];
    const t = (k === 4 ? c?.querySelector('.sp')?.textContent : c?.textContent) || '';
    if (t) w = Math.max(w, ovMeasure.measureText(t).width);
  }
  const ws = ovCols();
  ws[k] = Math.max(OVCOL_MIN, Math.ceil(w) + 16);
  applyOvCols(ws);
  saveOvCols(ws);
}
function winsHtml() {
  return WINS.filter((w) => !w.need || w.need()).map((w) => `<div class="pl-w pl-win-${w.id}${w.id === 'ov' ? ' pl-ov' : ''}${w.nokill ? ' nokill' : ''}" data-win="${w.id}" hidden>
    <div class="pl-wh" data-win-drag><img class="pl-wi" src="${winIcon(w)}" alt=""><span${w.id === 'ov' ? ' id="plOvTitle"' : ''}>${w.id === 'ov' ? ovTitle() : w.id === 'fleet' ? esc(tr(FL.fleetTitle())) : w.title}</span>
      ${w.more ? `<button type="button" data-win-more title="更多"><img src="${UI}eveicon/system_icons/more_vertical_16px.png?v=1" alt=""></button>` : ''}<button type="button" data-win-lock title="锁定窗口"><img src="${UI}classes/window/btnunlock.png?v=1" alt=""></button><button type="button" data-win-min title="最小化"><img src="${UI}eveicon/system_icons/minimize_16px.png?v=1" alt=""></button>${w.nokill ? '' : `<button type="button" data-win-close title="关闭"><img src="${UI}classes/window/btnclose.png?v=1" alt=""></button>`}</div>
    <div class="pl-wbody">${winBody[w.id]()}</div>
    ${WIN_RS.map((d) => `<i class="pl-wrs ${d}" data-win-resize="${d}"></i>`).join('')}</div>`).join('');
}
function neocomHtml() {
  return `<nav class="pl-neo" aria-label="窗口"><span class="pl-neo-eve"><img src="${UI}shared/hamburgermenu_large.png?v=1" alt=""></span>${WINS.filter((w) => !w.need || w.need()).map((w) => `<button type="button" data-win-open="${w.id}" title="${w.title}"><img src="${winIcon(w)}" alt=""></button>`).join('')}
    <button type="button" data-win-reset title="窗口恢复默认位置" class="pl-neo-reset"><img src="${UI}windowicons/navigation.png?v=1" alt=""></button><time class="pl-neo-clock" id="plNeoClock" title="EVE 时间"></time></nav>`;
}
// 按保存的位置（没有就用默认）摆放，并限制在画面里
// 全屏：只把驾驶画面（#plStage）铺满屏幕，去掉网站导航和页边。贴着右边 / 下边的窗口切换后仍贴着
function toggleFull() {
  const stage = root.querySelector('#plStage');
  if (!stage) return;
  stage.dataset.fw = stage.clientWidth; stage.dataset.fh = stage.clientHeight;
  if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return; }
  (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage)?.catch?.(() => {});
}
document.addEventListener('fullscreenchange', () => {
  const stage = root?.querySelector('#plStage');
  for (const b of document.querySelectorAll('[data-pl-full]')) b.textContent = tr(document.fullscreenElement ? '退出全屏' : '全屏');
  if (!stage) return;
  const W0 = Number(stage.dataset.fw) || 0, H0 = Number(stage.dataset.fh) || 0;
  requestAnimationFrame(() => {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (W0 && H0) for (const el of stage.querySelectorAll('[data-win]')) {
      const x = Number(el.dataset.hx ?? el.offsetLeft), y = Number(el.dataset.hy ?? el.offsetTop), w = el.offsetWidth, h = el.offsetHeight;
      const nx = x + w >= W0 - 24 ? x + (W - W0) : x, ny = y + h >= H0 - 24 ? y + (H - H0) : y;
      if (nx !== x || ny !== y) moveWin(el, nx, ny);
    }
    stage.dataset.fw = W; stage.dataset.fh = H;
  });
});

// 锁定窗口：标题栏锁图标换成「已锁」，不能拖动和缩放
function lockWin(el, on) {
  if (!el) return;
  el.classList.toggle('locked', on);
  const b = el.querySelector('[data-win-lock]');
  if (!b) return;
  b.title = tr(on ? '解锁窗口' : '锁定窗口');
  b.querySelector('img').src = `${UI}classes/window/${on ? 'btnlock' : 'btnunlock'}.png?v=1`;
}
function placeWins(reset = false) {
  const stage = root.querySelector('#plStage');
  if (!stage) return;
  const W = stage.clientWidth, H = stage.clientHeight;
  const saved = reset ? {} : winLayout();
  for (const el of stage.querySelectorAll('[data-win]')) {
    const d = WINS.find((w) => w.id === el.dataset.win), s0 = saved[d.id];
    const w = Math.min(W - 60, s0?.w || d.w), h = Math.min(H - 20, s0?.h || d.h);
    const x = s0 ? s0.x : d.r != null ? W - d.r - w : d.x;
    const y = s0 ? s0.y : d.b != null ? H - d.b - h : d.y;
    Object.assign(el.style, { width: w + 'px', height: h + 'px' });
    el.dataset.h = h;
    el.hidden = s0 ? !s0.open : Boolean(d.closed);
    el.classList.toggle('min', Boolean(s0?.min));
    lockWin(el, Boolean(s0?.lock));
    el.dataset.hx = Math.round(x); el.dataset.hy = Math.round(y);
    moveWin(el, x, y, true);
  }
  if (!stage.querySelector('[data-win].is-act')) setActWin(stage.querySelector('[data-win="ov"]:not([hidden])'));
  stage.dataset.fw = W; stage.dataset.fh = H;
  syncNeo();
}
// keep：只是画面变了，原位置（dataset.hx / hy）不动；否则这就是新的原位置
function moveWin(el, x, y, keep = false) {
  const stage = root.querySelector('#plStage');
  const W = stage.clientWidth, H = stage.clientHeight;
  if (W < 200 || H < 150) {            // 画面被临时收得很小（或还没显示）：先不动
    if (!keep) { el.dataset.hx = Math.round(x); el.dataset.hy = Math.round(y); }
    return;
  }
  const cx = Math.round(Math.max(48, Math.min(W - el.offsetWidth, x))), cy = Math.round(Math.max(0, Math.min(H - 32, y)));
  el.style.left = cx + 'px';
  el.style.top = cy + 'px';
  if (!keep) { el.dataset.hx = cx; el.dataset.hy = cy; }
}
function syncNeo() {
  for (const b of root.querySelectorAll('[data-win-open]')) {
    const open = !root.querySelector(`[data-win="${b.dataset.winOpen}"]`)?.hidden;
    b.classList.toggle('on', open);
    if (open) b.classList.remove('imp');
  }
}
let zTop = 10;
// 窗口置顶：层级只在 10–40 之间（超了按现有前后顺序重新排），教程、右键菜单、提示这些浮层固定在 40 以上，永远压在窗口上面
function raiseWin(win) {
  if (zTop >= 40) {
    const ws = [...root.querySelectorAll('[data-win]')].sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
    zTop = 10;
    for (const w of ws) w.style.zIndex = w === win ? '' : ++zTop;
  }
  win.style.zIndex = ++zTop;
}
// 当前窗口（最后点过的）：顶边主题色线 + 标题变亮，和客户端一样同一时间只有一个
function setActWin(win) {
  for (const el of root.querySelectorAll('[data-win].is-act')) if (el !== win) el.classList.remove('is-act');
  win?.classList.add('is-act');
}
// 拖动 / 缩放：贴近画面边缘或别的窗口边缘 8 像素内自动吸附（游戏里也是这样）
function snap(v, list) { for (const x of list) if (Math.abs(v - x) < 8) return x; return v; }
function onWinPointer(e) {
  const win = e.target.closest('[data-win]');
  if (!win) return;
  raiseWin(win);
  setActWin(win);
  const sc = e.target.closest('[data-ov-scale]');
  if (sc) { onOvScale(e, sc); return; }
  const drag = e.target.closest('[data-win-drag]') && !e.target.closest('button');
  const rs = e.target.closest('[data-win-resize]'), dir = rs?.dataset.winResize || '';
  if (!drag && !rs) return;
  if (win.classList.contains('locked')) return;   // 锁定的窗口不能拖动、缩放（客户端窗口标题栏的锁）
  e.preventDefault();
  const stage = root.querySelector('#plStage');
  const W = stage.clientWidth, H = stage.clientHeight;
  const x0 = e.clientX, y0 = e.clientY, l0 = win.offsetLeft, t0 = win.offsetTop, w0 = win.offsetWidth, h0 = win.offsetHeight;
  const others = [...stage.querySelectorAll('[data-win]')].filter((x) => x !== win && !x.hidden);
  const xs = [44, W, ...others.flatMap((o) => [o.offsetLeft, o.offsetLeft + o.offsetWidth])];
  const ys = [0, H, ...others.flatMap((o) => [o.offsetTop, o.offsetTop + o.offsetHeight])];
  const move = (ev) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (drag) {
      let x = l0 + dx, y = t0 + dy;
      const sx = snap(x, xs), sx2 = snap(x + w0, xs) - w0;
      x = sx !== x ? sx : sx2;
      const sy = snap(y, ys), sy2 = snap(y + h0, ys) - h0;
      y = sy !== y ? sy : sy2;
      moveWin(win, x, y);
    } else {
      let l = l0, t = t0, w = w0, h = h0;
      if (dir.includes('e')) w = Math.max(200, Math.min(W - l0, snap(l0 + w0 + dx, xs) - l0));
      if (dir.includes('w')) { l = Math.max(48, Math.min(l0 + w0 - 200, snap(l0 + dx, xs))); w = l0 + w0 - l; }
      if (dir.includes('s')) h = Math.max(70, Math.min(H - t0, snap(t0 + h0 + dy, ys) - t0));
      if (dir.includes('n')) { t = Math.max(0, Math.min(t0 + h0 - 70, snap(t0 + dy, ys))); h = t0 + h0 - t; }
      win.style.width = w + 'px';
      win.style.height = h + 'px';
      win.dataset.h = h;
      if (l !== l0 || t !== t0) { win.style.left = l + 'px'; win.style.top = t + 'px'; win.dataset.hx = l; win.dataset.hy = t; }
      if (win.dataset.win === 'ov') ovLine();
      rs.classList.add('on');
    }
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); rs?.classList.remove('on'); saveWins(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}
function toggleWin(id, show) {
  const el = root.querySelector(`[data-win="${id}"]`);
  if (!el) return;
  el.hidden = show == null ? !el.hidden : !show;
  if (!el.hidden) { raiseWin(el); setActWin(el); moveWin(el, Number(el.dataset.hx ?? el.offsetLeft), Number(el.dataset.hy ?? el.offsetTop), true); }
  if (id === 'log' && !el.hidden) renderLog();
  if (id === 'cargo' && !el.hidden) CG.renderCargo();
  if (id === 'loot') { if (el.hidden) S.lootCel = -1; else CG.renderLoot(); }
  if (id === 'dscan' && !el.hidden) { SC.renderDscan(true); SC.dscan(); }
  if (id === 'probe' && !el.hidden) SC.renderProbe(true);
  syncNeo();
  saveWins();
}

// ---------- 战斗画面 ----------
// 船体面板左边那一簇按钮（客户端 HudButtonsCont / LeftSideButton）：36×36，底座 utilBtnBaseAndShadow，图标 32×32；
// 两列错开排：右列（COL1）战术视角 / 环绕视角 / 第一人称视角，左列（COL2 = 28）货柜舱 / 战术视图 / 扫描器 / 自动导航，行距 16。
// 整簇右边缘在面板中心左边 80、竖直居中再往下 15。模拟里只有战术视图能用，环绕视角是当前视角（亮着）
const HUD_BTNS = [
  [28, 0, 'icons/44_32_10.png', '货舱和挂舱', 'cargo'],   // 客户端 OpenCargoHoldOfActiveShip（Tooltips/Hud/CargoHold），默认没有快捷键
  [0, 16, 'classes/shipui/iconcameragrid.png', '启用战术视角（模拟中不可用）'],
  [28, 32, 'icons/44_32_42.png', '开/关战术视图（Ctrl + D）', 'tac'],
  [0, 48, 'classes/shipui/iconcameraorbit.png', '启用环绕视角', 'orbit'],
  [28, 64, 'classes/sensorsuite/radar.png', '扫描器', 'scan'],
  [0, 80, 'classes/shipui/iconcamerafirstperson.png', '启用第一人称视角（模拟中不可用）'],
  [28, 96, 'icons/44_32_12.png', '开启/关闭自动导航（模拟中不可用）']
];
function hudBtnsHtml() {
  return `<div class="pl-hbtns">${HUD_BTNS.map(([col, top, icon, tip, id]) => `<button type="button" class="pl-hbtn${id === 'orbit' || (id === 'tac' && S.set.tac) ? ' on' : ''}${id ? '' : ' na'}"${id === 'tac' ? ' data-pl-tac' : ''}${id === 'scan' ? ' data-pl-scanbtn' : ''}${id === 'cargo' ? ' data-pl-cargobtn' : ''} style="right:${col}px;top:${top}px" title="${tip}" aria-label="${tip}"><i></i><img src="${UI}${icon}?v=1" alt="">${id === 'scan' ? `<img class="sw" src="${UI}classes/sensorsuite/radar_sweep.png?v=1" alt="">` : ''}</button>`).join('')}</div>`;
}
// 舰船模式按钮（客户端 StanceButtons / ShipStanceButton）：装备栏左边一列，36×36 的 LeftSideButton，第 k 个在 left 10×(k%2)、top 40×k；
// 整列在船体面板中心右边 66（SLOTS_CONTAINER_LEFT + 4 − 8），竖直居中往下 1，有模式时装备栏往右让 32。
// 当前模式亮 utilBtnGlow；切换后另外几个图标半透明，冷却计时（ShipModuleReactivationTimer：黑底 + 18 段虚线圈，按剩余时间缩短）
// 是最后加进按钮的子元素，客户端里画在底座下面
const STANCE_ICON = ['defense', 'sharpshooter', 'propulsion'];
const stanceName = (id) => ctx.FE.modeLabel(ctx.data, id);
function renderStance() {
  const el = root.querySelector('#plStance');
  if (!el) return;
  const list = S.modes || [];
  root.querySelector('#plHud')?.classList.toggle('stance', list.length > 0);
  el.innerHTML = list.map((id, k) => {
    const tip = `${stanceName(id)}（Shift + ${k + 1}）`;
    return id ? `<button type="button" class="pl-hbtn pl-stb" data-pl-stance="${k}" style="left:${10 * (k % 2)}px;top:${40 * k}px" title="${esc(tip)}" aria-label="${esc(tip)}"><s></s><u></u><i></i><img src="${UI}hud/stance_icon_${STANCE_ICON[k]}.png?v=1" alt=""></button>` : '';
  }).join('');
  S.stanceK = null;
  updStance();
}
function updStance() {
  const el = root.querySelector('#plStance');
  if (!el || !S.modes?.length) return;
  const left = RL.modeLeft(), p = left > 0 ? left / (S.modeCd || 1) : 0;
  const key = S.mode + '|' + (p > 0);
  if (key !== S.stanceK) {
    S.stanceK = key;
    for (const b of el.querySelectorAll('[data-pl-stance]')) {
      const on = S.modes[Number(b.dataset.plStance)] === S.mode;
      b.classList.toggle('on', on);
      b.classList.toggle('cd', p > 0 && !on);
    }
  }
  if (p > 0) el.style.setProperty('--p', p.toFixed(4));
}
function renderStage() {
  disposeView();
  const sky = S.sky || SKIES[0];
  root.innerHTML = `<div class="pl-page"><section class="pl-stage" id="plStage">
    <div class="pl-3d" id="pl3d"><p class="pl-3d-load" id="plLoad" hidden></p></div>
    <canvas class="pl-marks" id="plMarks"></canvas>
    <div class="pl-tcur" id="plTcur" hidden><i></i><i></i><i></i><i></i></div>
    ${neocomHtml()}
    <div class="pl-targets" id="plTargets"></div>
    ${winsHtml()}
    <div class="pl-hud" id="plHud">
      <canvas class="pl-hud-c" id="plHudC" width="360" height="200" aria-label="船体状态"></canvas>
      <button type="button" class="pl-spd" data-pl-spd="stop" title="停船（Ctrl + 空格）"><img src="${UI}classes/shipui/minus.png?v=1" alt=""></button>
      <button type="button" class="pl-spd max" data-pl-spd="max" title="全速"><img src="${UI}classes/shipui/plus.png?v=1" alt=""></button>
      <div class="pl-rack" id="plRack"></div>
      <div class="pl-stance" id="plStance"></div>
      ${hudBtnsHtml()}
      <button type="button" class="pl-hudopt" data-pl-hudopt title="选项" aria-label="选项"><img src="${UI}icons/73_16_50.png?v=1" alt=""></button>
      <div class="pl-buffs" id="plBuffs"></div>
    </div>
    <div class="pl-dmsg" id="plDmsg" aria-live="off"></div>
    <div class="pl-ind" id="plInd" aria-live="polite"><div class="pl-ind-c"><img alt="" hidden><b></b></div><p></p><i class="pl-ind-bar" hidden><s></s></i></div>
    <div class="pl-end" id="plEnd" hidden></div>
    <div class="pl-loading" id="plLoading"><div class="pl-loading-box">
      <div class="pl-spin"><img src="${UI}classes/loadingwheel/spinner.png?v=1" alt=""></div>
      <b>${esc(typeName(flyShip()))}</b><span id="plLoadTxt">正在准备战场…</span>
      <div class="pl-loadbar"><i id="plLoadBar"></i></div></div></div>
  </section></div>`;
  S.sky = sky;
  placeWins();
  renderShip();
  renderDrones();
  resetMsgs();
  renderRack();
  renderStance();
  renderSel();
  root.querySelector('#plHud').addEventListener('click', onHudClick);
  const hc = root.querySelector('#plHudC');
  hc.addEventListener('pointermove', onHudMove);
  // 鼠标在舰船 HUD（电容环、装备架）上：瞄准十字线隐藏（HUD 外框不接鼠标，按实际接到事件的元素判断）
  root.querySelector('#plStage')?.addEventListener('pointermove', (e) => { S.overHud = Boolean(e.target.closest?.('#plHud')); });
  hc.addEventListener('pointerleave', hideHudTip);
  const rk = root.querySelector('#plRack');
  rk.addEventListener('dragstart', onRackDragStart);
  rk.addEventListener('dragend', onRackDragEnd);
  rk.addEventListener('dragover', onRackDragOver);
  rk.addEventListener('drop', onRackDrop);
  rk.addEventListener('pointerover', onRackHover);
  rk.addEventListener('pointerout', onRackOut);
  rk.addEventListener('contextmenu', (e) => { const b = e.target.closest?.('.pl-mod'); if (!b) return; e.preventDefault(); openModMenu(Number(b.dataset.plMod), e); });
  rk.addEventListener('pointerover', (e) => { const b = e.target.closest?.('.pl-mod'); const m = b ? Number(b.dataset.plMod) : null; if (m !== S.tacMod) { S.tacMod = m; applyTac(); } });
  rk.addEventListener('pointerleave', () => { if (S.tacMod != null) { S.tacMod = null; applyTac(); } });
  const sw = root.querySelector('[data-win="sel"]');
  sw?.addEventListener('pointerover', onHintOver);
  sw?.addEventListener('pointerout', onHintOut);
  sw?.addEventListener('contextmenu', onSelCtx);
  // 舰队窗口、总览行的右键菜单；舰队成员拖进关注列表
  const stg = root.querySelector('#plStage');
  stg.addEventListener('contextmenu', onStageCtx);
  CG.bindDrag(stg);   // 残骸窗口的一行拖到货柜舱窗口
  stg.addEventListener('dragstart', (e) => FL.fleetDragStart(e));
  stg.addEventListener('dragover', (e) => FL.fleetDragOver(e));
  stg.addEventListener('drop', (e) => FL.fleetDrop(e));
  FL.renderFleet(true);
  SC.bindScanWin(stg);
  requestAnimationFrame(ovLine);
  import('./sim-3d.js?v=v90').then((m) => {
    const host = root.querySelector('#pl3d');
    if (!host || !S.b) return;
    S.view = m.createView(host, {
      onPick: (i, e) => { if (S.mv && (i < 0 || S.mv.state === 'y')) { mvAddPoint(); return; } if (S.mv) mvAbort(); pickUnit(i, e); },
      onDblEmpty: (d) => { if (!S.mv) cmd({ cmd: 'dir', dir: d, tgt: null }); },
      // 天体：图标按总览页签过滤；点击选中（S / Q 加点击 = 跃迁 / 接近），双击同总览；选中 / 悬停时写名字和距离
      // 跃迁隧道：自己的船在跃迁中时给出方向、速度比（÷ 3 AU × 跃迁速度倍率）、淡入淡出、镜头抖动强度
      warpFx: () => warpFx(),
      self: () => S.me?.i ?? -1,
      onPickCel: (c, e) => { if (S.mv) mvAbort(); pickCel(c, e); },
      onDblCel: (c) => celDbl(c),
      celShown: (c) => { const x = S.b?.cel[c]; return Boolean(x) && !ovPvp() && ovShowsGroup(x.group) && !ST.celHidden(x); },
      unitShown: (i) => { const v = S.b?.units[i]; return !v || (onGrid(v) && !(v.lootBox && !v.alive)); },
      celName: (c) => { const x = S.b?.cel[c]; return x && S.me ? `${x.name}  ${fmtDist(celDist(S.me, x))}` : ''; },
      onFollowDbl: false,
      nameOf: (i) => (i === S.sel ? S.names[i] : ''),
      onHover: (i) => { S.hoverShip = i >= 0; cursorMode(); },
      onTrack: () => renderSel(),
      onCtx: (i, c, e) => { if (!S.mv && S.me && i === S.me.i) { e.preventDefault(); selfMenu(e); } }
    }, { brackets: brkPath, ui: UI, quality: 'auto', skybox: `${UI}sky/${S.sky}/`, fx: `${UI}fx/`, post: true, fov: 1.0 });   // 客户端环绕镜头 default_fov = 1.0 弧度（「镜头动态移动」关着时）
    if (!S.view) { S.noView = tr('这个浏览器不支持 3D（WebGL）'); return; }
    // 指定空间点航行（客户端 navigation.py + positionalControl）：按住 Q、鼠标在太空里且没按键时开始；左键拖动（转镜头）取消；
    // 鼠标离开太空且第一点还没定时取消；右键取消
    host.addEventListener('pointermove', (e) => {
      S.mxy = [e.clientX, e.clientY];
      S.tcXY = S.mxy;   // 瞄准十字线跟着太空里的鼠标（客户端 InflightLayer.OnMouseMove 更新 tcursor 位置；鼠标到窗口上停在最后的位置）
      if (S.mv && (e.buttons & 1) && S.mvDown && Math.hypot(e.clientX - S.mvDown[0], e.clientY - S.mvDown[1]) >= 6) { mvAbort(); return; }
      if (!S.mv && !e.buttons && S.keys.has('q')) mvStart();
    });
    host.addEventListener('pointerdown', (e) => { S.mvDown = [e.clientX, e.clientY]; });
    host.addEventListener('pointerleave', () => { S.mxy = null; if (S.mv && S.mv.state === 'xz') mvAbort(); });
    host.addEventListener('contextmenu', (e) => { if (S.mv) { e.preventDefault(); mvAbort(); } });
    S.view.setRecord(S.b.rec);
    S.view.setLabels(true);
    S.view.draw(0, {});
    S.view.setOwnSide?.(S.me?.side);
    S.view.follow(S.me?.i ?? 0);
    if (S.envFx) S.view.setEnvFx?.(S.envFx);   // 场景房间的边界 / 气云 / 天气云层（视图是异步建的，进房间时可能还没好）
    applyTac();
  }).catch(() => { S.noView = tr('3D 画面加载失败'); });
  startLoop();
}
function disposeView() {
  S.jumpFx?.cancel();
  S.jumpFx = null;
  S.view?.dispose();
  S.view = null;
  S.ready = false;
  S.noView = '';
  S.load0 = performance.now();
}

// ---------- 开局加载：模型、星空、特效贴图、界面贴图都好了才开始（最多等 40 秒）----------
function checkLoad(now) {
  const bar = root.querySelector('#plLoadBar'), txt = root.querySelector('#plLoadTxt');
  const ui = PRELOAD.filter((p) => { const im = tex(p); return im.complete; }).length;
  const v = S.view?.loadState?.();
  const parts = [ui / PRELOAD.length];
  let msg = '加载界面贴图';
  if (v) {
    parts.push(v.index ? (v.total ? v.done / v.total : 0) : 0, v.sky ? 1 : 0, v.fx ? 1 : 0);
    if (!v.index || !v.total || v.done < v.total) msg = v.total ? `${tr('加载舰船模型')} ${v.done} / ${v.total}` : tr('加载舰船模型');
    else if (!v.sky) msg = tr('加载星空');
    else if (!v.fx) msg = tr('加载特效');
  } else parts.push(0, 0, 0);
  const f = parts.reduce((a, b) => a + b, 0) / 4;
  if (bar) bar.style.width = (f * 100).toFixed(1) + '%';
  if (txt) txt.textContent = S.noView || tr(msg);
  const done = (v && f >= 0.999) || S.noView || now - S.load0 > 40000;
  if (!done) return false;
  S.ready = true;
  S.last = now;
  const box = root.querySelector('#plLoading');
  if (box) { box.classList.add('out'); setTimeout(() => box.remove(), 600); }
  if (S.noView) { const el = root.querySelector('#plLoad'); if (el) { el.hidden = false; el.textContent = S.noView; } }
  return true;
}

// ---------- 战术视图（Ctrl + D）：射程取主武器（最远的那组）的最佳射程 / 失准范围，锁定距离 ----------
// 战术视图（客户端 tacticalOverlay）：平时只画锁定距离；鼠标停在装备上时画这件装备的最佳 / 失准距离；当前目标的竖线是白色
function applyTac(quiet = false) {
  if (!S.view?.setTactical) return;
  root.querySelector('[data-pl-tac]')?.classList.toggle('on', S.set.tac);
  if (!S.set.tac) { S.view.setTactical(null); return; }
  const u = S.me?.t || S.on, m = S.tacMod;   // 当前属性（换弹药 / 模式后的射程）
  let opt = 0, fall = 0;
  if (m != null && u) {
    const g = u.guns.find((x) => x.m === m);
    const me = S.me, M = (k) => me?.[k] ?? 1;   // 实时系数（干扰、塔）
    if (g) { opt = g.turret && !g.vorton ? (g.opt || 0) * M('optMult') : (g.reach || 0) * (g.turret ? 1 : M('mvelMult') * M('flightMult')); fall = g.turret && !g.vorton ? (g.fall || 0) * M('fallMult') : 0; }
    else for (const k of ['webs', 'points', 'paints', 'damps', 'ecms', 'neuts', 'noses', 'remote']) {
      const x = (u[k] || []).find((y) => y.m === m);
      if (x) { opt = x.range || 0; fall = x.falloff || 0; break; }
    }
  }
  const act = S.me?.pilot?.active;
  const key = [opt, fall, u?.lockRange, S.me?.rangeMult, act?.alive ? act.i : -1].join('|');
  if (quiet && key === S.tacKey) return;
  S.tacKey = key;
  S.view.setTactical({ center: 0, opt: opt / 1000, fall: fall / 1000, lock: (u?.lockRange || 0) * (S.me?.rangeMult ?? 1) / 1000, interest: act?.alive ? act.i : -1, aggr: tacAggr });
}
// 战术视图里「有敌意」的物体（客户端 tacticalOverlay._aggressorStates：我锁着 / 正在锁的、锁定我 / 攻击我的）——速度箭头会闪、并画直冲我来的红箭头
function tacAggr(i) {
  const v = S.b?.units[i], me = S.me;
  return Boolean(v && me && (me.pilot?.locks.has(v) || v.target === me || v.pilot?.locks.has(me)));
}
function toggleTac() { S.set.tac = !S.set.tac; save(); applyTac(); }
// 鼠标指针：Ctrl = 锁定准星，按住 Q / W / E = 移动指令，悬停舰船 = 带菜单的箭头
function cursorMode() {
  const st = root?.querySelector('#plStage');
  if (!st) return;
  st.classList.toggle('cur-lock', Boolean(S.ctrl));
  st.classList.toggle('cur-move', !S.ctrl && ['q', 'w', 'e'].some((k) => S.keys.has(k)));
  st.classList.toggle('cur-ship', Boolean(S.hoverShip));
  // 按住 Q / W / E / Ctrl：HUD 上方提示「接近 / 环绕 / 保持距离 / 锁定目标 —— 点击目标」（只按修饰键时晚 0.3 秒出）
  const k = ['q', 'w', 'e'].find((x) => S.keys.has(x));
  const cap = k ? { q: '接近', w: '环绕', e: '保持距离' }[k] : S.ctrl ? '锁定目标' : '';
  indShort(cap ? { cap, text: '点击目标' } : null, k ? 0 : 300);
}

// ---------- HUD 上方的动作提示（客户端 shipHud/action_indication）：宽 800 居中、在 HUD 上面 8 像素，
// 标题白色发光（可闪一下）+ 正文灰白，出现 / 消失 0.3 秒；临时提示 2 秒。按住快捷键的提示优先，其次临时提示 ----------
const IND = { short: null, temp: null, warp: null, tTimer: 0, sTimer: 0, cur: null };
function indTemp(cap, text = '', blink = true) {
  IND.temp = { cap, text };
  clearTimeout(IND.tTimer);
  IND.tTimer = setTimeout(() => { IND.temp = null; indUpdate(); }, 2000);
  indUpdate(blink);
}
function indShort(d, delay) {
  clearTimeout(IND.sTimer);
  if (!d) { if (IND.short) { IND.short = null; indUpdate(); } return; }
  if (IND.short?.cap === d.cap) return;
  const go = () => { IND.temp = null; IND.short = d; indUpdate(); };
  if (delay) IND.sTimer = setTimeout(go, delay); else go();
}
function indUpdate(blink) {
  const el = root?.querySelector('#plInd');
  if (!el) return;
  const d = IND.short || IND.warp || IND.temp;
  if (d && d !== IND.cur) {
    el.querySelector('b').textContent = tr(d.cap);
    el.querySelector('p').textContent = d.text ? tr(d.text) : '';
    el.querySelector('.pl-ind-bar').hidden = d.prog == null;
  }
  IND.cur = d;
  el.classList.toggle('on', Boolean(d));
  if (blink && d) { const b = el.querySelector('b'); b.classList.remove('blink'); void b.offsetWidth; b.classList.add('blink'); }
}

// ---------- 主循环：实时推进引擎，画 3D、界面 ----------
function startLoop() {
  if (S.raf) return;
  S.last = performance.now();
  S.raf = requestAnimationFrame(tick);
}
function stopLoop() { cancelAnimationFrame(S.raf); S.raf = 0; }
// 瞄准十字线（客户端 InflightLayer.sr.tcursor）：有装备在等你点目标时（targetMgr.OrderTarget → ShowTargetingCursor）显示，
// 等的装备都取消 / 开起来了就隐藏；鼠标进到舰船 HUD 上也隐藏（shipUI.OnMouseEnter → HideTargetingCursor）。
// 四条 1 像素的线（Line 默认色 白 15%），离鼠标 10 像素起，横竖贯穿整个画面
function tcursor() {
  const el = root.querySelector('#plTcur');
  if (!el) return;
  const show = Boolean(S.rk?.wait?.size && S.tcXY && !S.overHud && S.me?.alive);
  if (el.hidden === show) el.hidden = !show;
  if (show) {
    const r = el.parentElement.getBoundingClientRect();
    el.style.transform = `translate(${S.tcXY[0] - r.left - 1}px, ${S.tcXY[1] - r.top}px)`;
  }
}
function tick(now) {
  S.raf = 0;
  const b = S.b;
  if (!b || !root.querySelector('#plStage')) return;
  tcursor();
  const dt = Math.min(0.25, (now - S.last) / 1000);   // 掉帧时也按真实时间走（最多补 0.25 秒）
  S.last = now;
  if (active()) {
    if (!S.ready && !checkLoad(now)) {
      // 加载中：时钟不走，画面照常画（触发模型加载、预热着色器）
      if (S.view) { S.view.draw(0, { sel: -1, kills: [] }); S.view.render(); }
      S.raf = requestAnimationFrame(tick);
      return;
    }
    if (S.match && !S.ended) matchFrame(dt);
    else if (!S.paused && !S.ended) {
      S.t += dt;
      // 引擎比画面领先一步（画面在两帧之间插值）
      for (let n = 0; b.t < S.t + DT && !b.done && n < 8; n++) { beforeStep(); b.step(); afterStep(); }
      if (S.tut) tutTick();
      if (b.done || !S.me.alive) end();
    } else if (S.ended && !S.paused && S.t - S.endAt < 6) {
      // 结束后画面再走几秒：放完爆炸，2.5 秒后弹出结算
      S.t += dt;
      if (S.t - S.endAt > 2.5) root.querySelector('#plEnd')?.removeAttribute('hidden');
    }
    const t = S.ended ? Math.min(S.t, S.endAt + 6) : Math.min(S.t, b.t);
    if (S.view) { S.view.draw(t, { sel: S.sel, selC: S.selC, kills: b.kills }); S.view.render(); }
    drawMarks();
    warpInd();
    drawHud();
    updHudTip();
    drawTargets();
    updateRack();
    updStance();
    if (now - S.ovAt > 500) {
      S.ovAt = now;
      const sb = S.site && root.querySelector('#plSite');
      if (sb) { const h = ST.siteInfoHtml(); if (sb.dataset.h !== h) { sb.dataset.h = h; sb.innerHTML = h; } }
      if (S.set.tac) applyTac(true);   // 射程 / 锁定距离随干扰、塔、换弹药变
      if (!root.querySelector('[data-win="ship"]')?.hidden) renderShip();
      if (S.fleet && !S.match) FL.fleetTick(); renderOverview(); renderSel(true); renderDrones(); FL.renderFleet(); SC.renderDscan(); SC.renderProbe(); refreshTip(); ovLine(); }
    drawMsgs(now);
    const nc = root.querySelector('#plNeoClock');
    if (nc) { const v = new Date().toISOString().slice(11, 16); if (nc.textContent !== v) nc.textContent = v; }
    const c = root.querySelector('#plClock');
    if (c) c.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  }
  S.raf = requestAnimationFrame(tick);
}
// 主动装备开关：换成对应的属性（速度、信号半径、抗性、锁定、电容消耗…）；停用后这一轮跑完才失效
const beforeStep = () => R.beforeStep();
// ---------- 受到的电子战 / 遥修（客户端 buffBarContainer + buffButtons）----------
// 船体面板上方居中（top = SHIP_UI_HEIGHT 200，高 44）；每格 SLOT_WIDTH 48 × ICON_SIZE 40，图标 40 居中；
// 叠三层贴图：shadow（白 0.25）、slot_base（ewarBarUnderlayClean，加色 0.2）、slot_gradient（ewarBarUnderlayGrad，加色 0.25）；
// 敌方电子战 = OffensiveBuffButton（格子 0.7,0,0，图标 1,.7,.7），友方遥修 = DefensiveBuffButton（格子 0,.6,.6，图标 .7,1,1）；出现时宽度 0→48 用 0.25 秒
// 种类 → [客户端槽位（buffBarConst.Slot_*）, 图标（appConst.iconModule* → SDE icons 表的文件）, 提示标题（BUFF_SLOT_HINTS 的本地化原文）]
// 扰频（会关掉微曲）= warpScramblerMWD「被跃迁扰频」；扰断 = warpScrambler「跃迁被干扰」
const BUFF_INFO = {
  scram: ['warpScramblerMWD', '76_64_1', '被跃迁扰频'], point: ['warpScrambler', '4_64_9', '跃迁被干扰'], web: ['webify', '12_64_6', '被停滞缠绕'],
  ecm: ['electronic', '4_64_12', '被电子干扰'], damp: ['ewRemoteSensorDamp', '4_64_11', '被感应抑阻'], paint: ['ewTargetPaint', '56_64_1', '被目标标记'],
  nos: ['ewEnergyVampire', '1_64_3', '被吸掠电容'], neut: ['ewEnergyNeut', '12_64_4', '被中和电容'],
  rs: ['shieldTransfer', '1_64_16', '护盾传输'], ra: ['remoteArmorRepair', 'remote_armor_repair', '装甲维修'], rh: ['remoteHullRepair', 'remote_hull_repairer', '结构维修'],
};
// 指挥脉冲波（自己开的也算，客户端 dbuff 收到就显示）：弹药组 → 槽位（Slot_ShieldBurst 等，图标 appConst.iconShieldBurst 等）
const BURST_SLOT = { 1769: 'bShield', 1774: 'bArmor', 1773: 'bInfo', 1772: 'bSkirmish', 1771: 'bMining', 4905: 'bExpedition' };
Object.assign(BUFF_INFO, {
  bShield: ['shieldBurst', 'modules/fleetboost_shieldbase', '护盾脉冲波'], bArmor: ['armorBurst', 'modules/fleetboost_armorbase', '装甲脉冲波'],
  bInfo: ['informationBurst', 'modules/fleetboost_infobase', '信息战脉冲波'], bSkirmish: ['skirmishBurst', 'modules/fleetboost_skirmishbase', '游击战脉冲波'],
  bMining: ['miningBurst', 'modules/fleetboost_miningbase', '开采脉冲波'], bExpedition: ['expeditionBurst', 'modules/fleetboost_expeditionbase', '远征脉冲波'],
});
// 武器扰断 / 友方辅助（客户端 Slot_EwTrackingDisrupt 等，图标 appConst.iconModuleTrackingDisruptor 1639 → 5_64_7、GuidanceDisruptor 21437 → 5_64_17、
// RemoteTracking 3346 → 74_64_8、EnergyTransfer 1035 → 1_64_2、SensorBooster 74 → 3_64_9）；提示标题 = 客户端 UI/Inflight/EwarHints/* 的中文原文
Object.assign(BUFF_INFO, {
  td: ['ewTrackingDisrupt', '5_64_7', '被索敌扰断'], gd: ['ewGuidanceDisrupt', '5_64_17', '被制导干扰'],
  rt: ['remoteTracking', '74_64_8', '强化跟踪'], rc: ['energyTransfer', '1_64_2', '能量传输'], rb: ['sensorBooster', '3_64_9', '感应增强'],
});
// 深渊天气、气云、塔（客户端 Slot_Weather_* / Slot_Aoe*，图标 appConst.iconWeather* 21903~21907 / iconAoe* 21936~21941 → ui/texture/icons/statuseffects/*）
Object.assign(BUFF_INFO, {
  wxElec: ['weatherElectricStorm', 'statuseffects/weatherlightning', '电子风暴'], wxDark: ['weatherDarkness', 'statuseffects/weatherdarkness', '暗物质场'],
  wxCaustic: ['weatherCausticToxin', 'statuseffects/weathercaustic', '异种粒子风暴'], wxXenon: ['weatherXenonGas', 'statuseffects/weatherxenongas', '伽玛射线余波'],
  wxInfernal: ['weatherInfernal', 'statuseffects/weatherinfernal', '等离子火焰风暴'],
  aoeBio: ['aoeBioluminescenceCloud', 'statuseffects/bioluminescence', '生物荧光气云'], aoeCaustic: ['aoeCausticCloud', 'statuseffects/causticcloud', '超光速云'],
  aoeFilament: ['aoeFilamentCloud', 'statuseffects/filamentcloud', '纤维云'], aoePD: ['aoePointDefense', 'statuseffects/pointdefensebattery', '反无人机/-导弹定点防御'],
  aoePulse: ['aoePulsePlatform', 'statuseffects/pulsebattery', '追踪辅助脉冲'],
});
// 客户端 OFFENSIVE_SLOTS 只有电子战那几种，天气 / 气云 / 塔都不在里面 → 和遥修一样按非进攻样式
const SITE_SLOTS = ['wxElec', 'wxDark', 'wxCaustic', 'wxXenon', 'wxInfernal', 'aoeBio', 'aoeCaustic', 'aoeFilament', 'aoePD', 'aoePulse'];
const BUFF_DEF = new Set(['rs', 'ra', 'rh', 'rt', 'rc', 'rb', ...Object.values(BURST_SLOT), ...SITE_SLOTS]);
// 自己身上还有效的脉冲波加成：槽位 → { buffs: Map(加成 → 数值，同种取最强), end: 最晚到期, dur }
function burstsOnMe() {
  const out = new Map(), t = S.b.t;
  for (const [i, end] of S.bexp || []) {
    const bu = S.on.rack[i]?.burst, k = bu && BURST_SLOT[bu.grp];
    if (!k || end <= t) continue;
    let e = out.get(k);
    if (!e) out.set(k, (e = { buffs: new Map(), end: 0, dur: bu.dur }));
    for (const [id, v] of bu.buffs) {
      const b = ctx.data.dbuffs?.get(id), old = e.buffs.get(id);
      if (old === undefined || (b?.max ? v > old : v < old)) e.buffs.set(id, v);
    }
    if (end > e.end) { e.end = end; e.dur = bu.dur; }
  }
  return out;
}
// 剩余时间（客户端 FormatTimeIntervalShortWritten：「1分 5秒」）
const fmtLeft = (sec) => { const s0 = Math.max(0, Math.ceil(sec)), m = Math.floor(s0 / 60); return m ? `${m}分 ${s0 % 60}秒` : `${s0}秒`; };
const buffIcon = (k) => `${UI}icons/${BUFF_INFO[k][1]}.png?v=1`;
const buffHint = (k) => tr(BUFF_INFO[k][2]);
const bcHint = (k) => tr(FL.bcName(k));   // 同上：总览行里 tr 被行变量遮住   // 总览里 tr 是行变量，这里另起名字
// 客户端 tactical.jammersByJammingType：服务器发来 EWAR 通知才算（ECM 只有干扰成功的周期才有）
function ewarOnMe(u) {
  const out = new Map();   // 种类 → { from: Map(单位 → 装备件数), fail: Map（ECM 没干扰上的）, jam: 最近一次干扰 {t0, end} }
  const add = (k, v, key = 'from') => { let e = out.get(k); if (!e) out.set(k, (e = { from: new Map(), fail: new Map(), jam: null })); e[key].set(v, (e[key].get(v) || 0) + 1); };
  const on = (v, x) => x.m >= 0 && x.m < 32 && (v.act >>> x.m) & 1;
  const t = S.b.t;
  for (const v of S.b.units) {
    if (!v.alive || v === u) continue;
    if (v.target === u) {
      for (const x of v.t.points) if (on(v, x)) add(x.str >= 2 && !x.focus ? 'scram' : 'point', v);
      for (const [k, l] of [['web', v.t.webs], ['damp', v.t.damps], ['paint', v.t.paints], ['nos', v.t.noses], ['neut', v.t.neuts], ['td', v.t.tds || []], ['gd', v.t.gds || []]]) for (const x of l) if (on(v, x)) add(k, v);
    }
    if (v.rrep) v.t.remote.forEach((rep, j) => { if (v.rrep[j]?.tgt === u) add(['rs', 'ra', 'rh'][rep.layer], v); });
    // 友方辅助（远程电容传输 / 感应增强 / 跟踪电脑）：引擎每步记在 aOut
    for (const [x, m] of v.aOut || []) if (x === u) { const k = (v.t.rcaps || []).some((y) => y.m === m) ? 'rc' : (v.t.rsbs || []).some((y) => y.m === m) ? 'rb' : 'rt'; add(k, v); }
    // 跃迁扰断力场：在泡泡里就算「跃迁被干扰」
    for (const x of v.t.bubbles || []) if (on(v, x) && Math.hypot(v.pos[0] - u.pos[0], v.pos[1] - u.pos[1], v.pos[2] - u.pos[2]) <= x.range) add('point', v);
  }
  // 脉冲波投射器的力场：在里面就算对应的电子战（来源 = 开的那艘船）
  for (const f of S.b.fields || []) {
    if (!f.pos || t < f.at || f.u === u || Math.hypot(f.pos[0] - u.pos[0], f.pos[1] - u.pos[1], f.pos[2] - u.pos[2]) > f.x.radius) continue;
    const k = { web: 'web', paint: 'paint', damp: 'damp', bubble: 'point', guide: 'gd', track: 'td' }[f.x.kind];
    if (k) add(k, f.u);
    if (f.x.kind === 'track' && (f.x.mvel || f.x.ev)) add('gd', f.u);
  }
  // ECM：只有干扰成功、还没到期的才算；同时开着但没干扰上的记为「失败的尝试」
  const jams = [...(u.jamBy?.values() || [])].filter((j) => j.end > t && j.u.alive);
  if (jams.length) {
    for (const j of jams) add('ecm', j.u);
    const e = out.get('ecm');
    e.jam = jams.reduce((a, b) => (b.t0 > a.t0 ? b : a));
    for (const v of S.b.units) if (v.alive && v.target === u) for (const x of v.t.ecms) if (on(v, x) && !jams.some((j) => j.u === v && j.m === x.m)) add('ecm', v, 'fail');
  }
  return out;
}
// 图标按客户端 ICON_COLOR 着色（乘色，保留透明）
const tintedIcons = new Map();
function tintIcon(src, rgb) {
  const key = src + rgb;
  if (tintedIcons.has(key)) {
    const src0 = tintedIcons.get(key), c = src0.cloneNode();
    if (src0.dataset.ok) c.getContext('2d').drawImage(src0, 0, 0);
    return c;
  }
  const c = document.createElement('canvas');
  c.width = c.height = 40;
  const img = new Image();
  img.onload = () => {
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 40, 40);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = rgb; g.fillRect(0, 0, 40, 40);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(img, 0, 0, 40, 40);
    c.dataset.ok = '1';
    for (const x of root.querySelectorAll(`canvas[data-tint="${CSS.escape(key)}"]`)) if (x !== c) x.getContext('2d').drawImage(c, 0, 0);
  };
  img.src = src;
  c.dataset.tint = key;
  tintedIcons.set(key, c);
  return c;
}
function renderBuffs() {
  const box = root.querySelector('#plBuffs'), u = S.me;
  if (!box || !u) return;
  const ew = u.alive ? ewarOnMe(u) : new Map();
  S.ewar = ew;
  // 脉冲波加成和遥修一样是友方格子，倒计时圈显示加成还剩多久
  if (u.alive) for (const [k, b] of burstsOnMe()) ew.set(k, { from: new Map(), fail: new Map(), jam: { t0: b.end - b.dur, end: b.end }, burst: b });
  if (S.site) for (const [k, rows] of ST.siteBuffs(u)) ew.set(k, { from: new Map(), fail: new Map(), rows });
  const have = new Map([...box.children].map((x) => [x.dataset.k, x]));
  for (const [k, el] of have) if (!ew.has(k)) el.remove();
  for (const [k, e] of ew) {
    let el = have.get(k);
    if (!el) {
      const def = BUFF_DEF.has(k);
      el = document.createElement('div');
      el.className = `pl-buff ${def ? 'def' : 'off'}`;
      el.dataset.k = k;
      el.innerHTML = '<span class="bf"><i class="sh"></i><i class="sb"></i><i class="sg"></i><span class="tm"><i class="r"></i><i class="l"></i></span></span>';
      el.firstChild.insertBefore(tintIcon(buffIcon(k), def ? 'rgb(178,255,255)' : 'rgb(255,178,178)'), el.firstChild.querySelector('.tm'));
      // 客户端 FadeButtonIn → SetOrder：电子战插在 (来源数 − 1) 的位置（一个来源 = 最左边），遥修类排最后；已有的按钮不挪
      if (def) box.append(el);
      else box.insertBefore(el, box.children[Math.max(0, e.from.size - 1)] || null);
    }
    // 提示：标题 + 每个来源「N x 船名」（EwarAttackerNPC2：只显示船名），ECM 另列「失败的尝试」
    const rows = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${c}x  ${S.names[v.i]}`);
    // 脉冲波：每种加成一行「数值 名称 剩余时间」（BuffHintProvider.GetDbuffHintItemList）
    const bRows = e.burst ? [...e.burst.buffs].map(([id, v]) => `${ctx.FE.buffText(ctx.data, [[id, v]])[0] || ''}  ${tr(fmtLeft(e.burst.end - S.b.t))}`) : [];
    const tip = [buffHint(k), ...rows(e.from), ...(e.fail.size ? [tr('失败的尝试'), ...rows(e.fail)] : []), ...bRows, ...(e.rows || [])].join('\n');
    if (el.title !== tip) el.title = tip;
    // 倒计时圈（ModuleEffectTimer，倒数模式，白 0.65；电子战按钮用橙 1,0.3,0、遥修用青 0,0.8,0.8）：只有干扰（OnJamStart）有
    const tm = el.querySelector('.tm');
    if (e.jam) {
      const f = Math.max(0, Math.min(1, (S.b.t - e.jam.t0) / Math.max(0.1, e.jam.end - e.jam.t0)));
      tm.style.setProperty('--a', `${(f * 360).toFixed(1)}deg`);
      tm.hidden = false;
    } else tm.hidden = true;
  }
}
function afterStep() {
  const u = S.me;
  if (!u) return;
  if (S.site) ST.siteTick();   // 场景刷怪放在前面：新刷的 NPC 下面一起起名字
  if (S.lootCel >= 0) CG.cargoTick();
  // 放出的无人机成为新单位：名字就是型号名（客户端总览一样）
  for (let i = S.names.length; i < S.b.units.length; i++) S.names.push(typeName(S.b.units[i].r.row.ship));
  flushHits();
  // 装备被引擎停掉、超载过热、脉冲波加成、扰频停微曲、目标被打掉停武器：pilot-rules
  const prev = S.lastAct;
  R.afterStep();
  renderBuffs();
  if (prev !== u.pilot.active && S.set.tac) applyTac();
  for (const k of S.b.kills.slice(S.killN || 0)) pushLog(k.unit === u.i ? '你的船被摧毁了' : `${S.names[k.unit]} 被摧毁`, k.side === u.side ? 'bad' : 'good');
  S.killN = S.b.kills.length;
}
// ---------- 匹配对战（服务器 server/match_service.mjs；每一步怎么走见 match-sim.js）----------
const MODE_NAME = { '1v1': '1v1', '2v2': '2v2' };
const LIVE_KEY = 'eve-match-live';   // 对局进行中（刷新页面后自动连回去）
const capName = (c) => (c ? `${c / 1e6}M` : '不限');
const MH = {
  onState: () => { const box = root?.querySelector('#plMatch'); if (box) box.innerHTML = matchInner(); MH.onRooms(); },
  onMatch: (m) => startMatchView(m),
  onGo: () => { if (S.match) S.match.go = true; },
  onTick: (m) => { if (S.matchWait) S.matchWait.push(m); else if (S.match && !S.match.res) S.match.q.push(m); },
  onEnd: (m) => { try { sessionStorage.removeItem(LIVE_KEY); } catch { /* 隐私模式 */ } if (S.match) S.match.res = m; else MH.onState(); },
  onLost: () => { if (S.match) pushLog('与匹配服务断开，正在重连…', 'bad'); },
  onRooms: () => { const box = root?.querySelector('#plRooms'); if (box) box.innerHTML = roomsInner(); },
  // 发布 / 删除公开预设时的错误：弹提示，不当成匹配的错误
  onErr: (m) => { if (!PUB.wait) return false; PUB.wait = null; ctx.showToast(m.msg, 'error'); renderPresets(); return !m.fatal; },
  onPreset: (m) => { PUB.wait = null; ctx.showToast(m.del ? '已删除公开预设' : '已公开分享，其他玩家在「玩家分享」里能看到', 'success'); PUB.list = null; renderPresets(); if (!m.del) { S.set.ptab = 'pub'; save(); renderPresets(); } },
};
const SKILL_NAME = { esi: '角色技能', max: '全 5 级' };
function matchInner() {
  const err = MT.err ? `<p class="pl-mt-err">${esc(MT.err)}</p>` : '';
  if (!canMatch()) return `<p class="text-muted">要先在个人中心绑定 EVE 角色（ESI）才能匹配</p>`;
  if (MT.state === 'connecting') return `<p class="text-muted">正在连接匹配服务…</p>${err}`;
  const rule = (x) => `${esc(x.mode)} · ${esc(MATCH_BRACKETS[x.bracket]?.name || x.bracket)} · 上限 ${capName(x.cap)} · ${SKILL_NAME[x.skills] || ''}`;
  if (MT.state === 'queued' && MT.queued) {
    const q = MT.queued;
    return `<div class="pl-mt-st"><b>正在匹配…</b><span>${rule(q)}</span><span>这套装配 ${(q.value / 1e6).toFixed(1)}M ISK · 队列 ${q.n} 人</span>
      <button type="button" class="btn btn-ghost btn-sm" data-pl-mx>取消匹配</button></div>${err}`;
  }
  if (MT.state === 'room' && MT.room) {
    const r = MT.room;
    return `<div class="pl-mt-st"><b>${r.pub ? '公开房间' : '私人房间'} · 邀请码 <span class="pl-mt-code" translate="no">${esc(r.code)}</span></b><span>${rule(r)}</span>
      <span>${r.members.map((x) => `${shipChip(x.ship)} <b translate="no">${esc(x.name)}</b>`).join(' ')}</span>
      ${r.host ? (r.members.length >= 2 ? `<button type="button" class="btn btn-primary btn-sm" data-pl-mstart>开始</button>` : '<span class="text-muted">等待对手加入…</span>') : '<span class="text-muted">等待房主开始…</span>'}
      <button type="button" class="btn btn-ghost btn-sm" data-pl-mx>${r.host ? '关闭房间' : '退出房间'}</button></div>${err}`;
  }
  const mode = S.set.mmode || '1v1', cap = MATCH_CAPS.includes(S.set.mcap) ? S.set.mcap : MATCH_CAPS[0];
  const seg = (label, attr, list, cur) => `<label>${label}</label><div class="segmented" role="group" aria-label="${label}">${list.map(([v, l]) => `<button type="button" ${attr}="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  return `${seg('模式', 'data-pl-mm', Object.keys(MODE_NAME).map((k) => [k, k]), mode)}
    ${seg('装配价值上限', 'data-pl-mc', MATCH_CAPS.map((c) => [c, capName(c)]), cap)}
    ${seg('技能', 'data-pl-msk', Object.entries(SKILL_NAME), S.set.mskill)}
    <div class="pl-mt-go"><button type="button" class="btn btn-primary" data-pl-mq>快速匹配</button></div>
    <div class="pl-mt-row"><div class="segmented" role="group" aria-label="房间类型">${[[1, '公开'], [0, '私人']].map(([v, l]) => `<button type="button" data-pl-mpub="${v}" class="${S.set.mpub === Boolean(v) ? 'active' : ''}">${l}</button>`).join('')}</div><button type="button" class="btn btn-ghost btn-sm" data-pl-mr>创建房间</button></div>${err}`;
}
function roomsInner() {
  if (!canMatch()) return '<p class="text-muted">—</p>';
  if (!MT.rooms) return `<p class="text-muted">${MT.state === 'off' ? '未连接' : '正在读取…'}</p>`;
  const list = MT.rooms.filter((r) => !S.set.mroomf || r.mode === S.set.mroomf);
  if (!list.length) return `<p class="pl-rempty">${MT.rooms.length ? '没有这个模式的房间' : '暂时没有公开房间'}</p>`;
  // 我的船级别不同的房间进不去：灰掉，悬停说明
  const mine = bracketOf(ctx.data.types.get(S.set.ship)?.group);
  return list.map((r) => {
    const n = r.n || 1;
    const why = r.bracket !== mine ? `你的船是${MATCH_BRACKETS[mine]?.name || '不能参赛的舰船'}，这个房间要${MATCH_BRACKETS[r.bracket]?.name}` : n >= 2 ? '房间已满，等房主开始' : MT.state !== 'idle' ? '先取消正在进行的匹配或房间' : '';
    const act = r.mine ? '<span class="text-muted">我的房间</span>' : `<button type="button" class="btn btn-primary btn-sm" data-pl-mjoin="${esc(r.code)}"${why ? ` disabled title="${esc(why)}"` : ''}>加入房间</button>`;
    return `<div class="pl-rrow${r.bracket !== mine && !r.mine ? ' off' : ''}"><span class="pl-rown">${shipChip(r.ship)}<b translate="no">${esc(r.owner)}</b></span><span>${esc(r.mode)}</span><span>${esc(MATCH_BRACKETS[r.bracket]?.name || r.bracket)}</span><span>${capName(r.cap)}</span><span>${SKILL_NAME[r.skills] || ''}</span><span>${n} / 2</span>
      <span>${act}</span></div>`;
  }).join('');
}
// 打开「匹配对战」页签：连上服务器，每 5 秒刷新一次公开房间
let roomsTimer = 0;
function matchTab() {
  clearInterval(roomsTimer);
  if (!canMatch()) return;
  const poll = () => {
    if (!root?.querySelector('#plRooms') || S.b) { clearInterval(roomsTimer); return; }
    if (['idle', 'room', 'queued'].includes(MT.state)) matchSend({ op: 'rooms' });
  };
  if (MT.state === 'off') matchConnect(MH, () => ctx.getEsiToken()).then(poll); else poll();
  roomsTimer = setInterval(() => { if (!document.hidden) poll(); }, 5000);
}
async function matchGo(kind, code = '') {
  if (MT.state === 'connecting') return;
  MT.err = '';
  try {
    const f = await fitFor(S.set.ship, S.set.fit);
    const mine = await ctx.pilotRow(S.set.ship, f ? ctx.normalize(f) : null, f?.name || '', { self: true });
    const fit = mine.row.fit;
    if (!(await matchConnect(MH, () => ctx.getEsiToken()))) { MH.onState(); return; }
    const cap = MATCH_CAPS.includes(S.set.mcap) ? S.set.mcap : MATCH_CAPS[0];
    if (kind === 'join') matchSend({ op: 'join', code, fit });
    else matchSend({ op: kind, mode: S.set.mmode || '1v1', fit, cap, skills: S.set.mskill, pub: S.set.mpub });
  } catch (e) { MT.err = e.message; MH.onState(); }
}
// 服务器配好对局：按对局信息建同样的战斗（同一个种子、同样的装配和技能），画面用驾驶模拟的
function startMatchView(m) {
  S.fleet = null;   // 对战里不做舰队广播（广播不经过服务器）
  // 星系文件还没读到：读完再建（这段时间服务器发来的步数先存着）（天体要和服务器一样，否则跃迁指令会算出不同的结果）
  if (!SYS && !m.noSys) { S.matchWait = []; loadSys().then(() => { const q = S.matchWait; S.matchWait = null; startMatchView({ ...m, noSys: true }); if (S.match) S.match.q.push(...q); }); return; }
  stopLoop();
  disposeView();
  S.fitView = null;
  bindUnit(ctx, {});
  S.match = { mid: m.mid, you: m.you, info: m.info, q: [], go: Boolean(m.started), sent: false, res: null };
  try { sessionStorage.setItem(LIVE_KEY, m.mid); } catch { /* 隐私模式 */ }
  S.sky = matchSky(m.info.seed);
  const M = buildMatch({ pilotUnit, createBattle, systems: SYS, en: window.I18N?.lang === 'en' }, m.info, (p) => (p === m.you ? { S, R: RL } : null), { onHit: logHit, onDrain: logDrain });
  S.match.M = M;
  R = RM;
  const me = m.info.players[m.you];
  S.fitLabel = `${m.info.players.length === 2 ? '1v1' : '2v2'} 匹配`;
  S.names = M.b.units.map((u, i) => (i === S.me.i ? tr('我') : M.P.find((x) => x.unit === i)?.name || typeName(u.r.row.ship)));
  rackInit();
  // 掉线重连：从第一步重放到现在，再套上服务器最新的状态
  if (m.log?.length) {
    S.replay = true;
    try {
      for (const ops of m.log) { stepMatch(M, ops); for (let i = S.names.length; i < M.b.units.length; i++) S.names.push(typeName(M.b.units[i].r.row.ship)); }
      M.b.applySnap(m.s);
      m.rk.forEach((x, i) => applyRackSnap(M.P[i].S, x));
    } finally { S.replay = false; }
  }
  const foes = m.info.players.filter((x) => x.side !== me.side).map((x) => x.name).join('、');
  const mates = m.info.players.filter((x) => x.side === me.side && x.p !== m.you).map((x) => x.name).join('、');
  enter(m.log?.length ? '已重新连上对局' : `匹配到对手：${foes}${mates ? `；队友：${mates}` : ''}，相距 ${m.info.dist} km`);
}
// 每一帧：执行收到的服务器步数；画面时间跟在战斗时间后面约 0.5 秒（两步之间插值，网络有抖动也不卡）
function matchFrame(dt) {
  const X = S.match, b = S.b;
  if (!X.sent && S.ready) { X.sent = true; matchSend({ op: 'ready' }); }
  while (X.q.length) applyTick(X.q.shift());
  const lag = b.t - S.t;
  if (lag > 2) S.t = b.t - 0.6;
  else S.t = Math.min(b.t, S.t + dt * (lag > 0.8 ? 1.15 : lag < 0.35 ? 0.85 : 1));
  // 结果到了：先把已收到的步数走完（看得到最后那一下）再结算
  if (X.res && !X.q.length) end();
}
function applyTick(tk) {
  const X = S.match, M = X.M;
  if (tk.k <= M.k) return;
  stepMatch(M, tk.ops, (p) => (p === X.you ? afterStep : null));
  // 诊断：本地算的和服务器不一样的步数（同一个浏览器内核下应为 0）
  if (JSON.stringify(M.b.snap().u) !== JSON.stringify(tk.s.u)) X.drift = (X.drift || 0) + 1;
  M.b.applySnap(tk.s);
  tk.rk.forEach((x, i) => applyRackSnap(M.P[i].S, x));
}
function matchEndBox(box) {
  const X = S.match, r = X.res || {}, my = S.me.side;
  const won = r.winner === my, draw = !r.winner;
  const why = { kill: won ? '对方全部被击毁' : draw ? '双方同归于尽' : '我方全部被击毁', time: '时间到，按剩余血量比例判定', away: won ? '对方掉线超过 60 秒' : '我方掉线超过 60 秒', error: '服务器出错，本局作废', lost: '与服务器断开，对局已结束' }[r.reason] || '';
  const st = (r.stats || []).find((x) => x.p === X.you);
  box.innerHTML = `<div class="pl-win pl-w pl-end-win"><h3>${won ? '胜利' : draw ? '平局' : '失败'}</h3>
    <p>${esc(why)} · 用时 ${Math.floor((r.t || 0) / 60)} 分 ${Math.round((r.t || 0) % 60)} 秒${st ? ` · 造成伤害 ${ctx.formatNumber(st.dealt)} · 受到伤害 ${ctx.formatNumber(st.taken)}` : ''}</p>
    <div><button type="button" class="btn btn-primary" data-pl-exit>返回设置</button></div></div>`;
}
function end() {
  if (S.ended) return;
  S.ended = true;
  S.endAt = S.t;
  if (S.tut && tutEnd()) return;
  const won = S.me.alive;
  const box = root.querySelector('#plEnd');
  if (!box) return;
  if (S.match) { matchEndBox(box); return; }
  const kills = S.b.kills.filter((k) => k.side === 'B' && !k.drone).length;
  const title = S.site ? (won && S.siteEnd?.won ? S.siteEnd.text : won ? '时间到' : '你的船被摧毁了') : won ? '敌人全部被消灭' : '你的船被摧毁了';
  box.innerHTML = `<div class="pl-win pl-w pl-end-win"><h3>${title}</h3>
    ${S.site?.def ? `<p>${esc(window.I18N?.lang === 'en' ? S.site.def.en : S.site.def.name)} · ${ST.siteSummary()}</p>` : ''}
    <p>用时 ${Math.floor(S.b.t / 60)} 分 ${Math.round(S.b.t % 60)} 秒 · 击毁 ${kills} 艘 · 造成伤害 ${ctx.formatNumber(Math.round(S.me.r.dealt))} · 受到伤害 ${ctx.formatNumber(Math.round(S.me.r.taken))}</p>
    <div><button type="button" class="btn btn-primary" data-pl-restart>再来一次</button> <button type="button" class="btn btn-ghost" data-pl-exit>返回设置</button></div></div>`;
}

// ---------- 跃迁 ----------
// 默认的「跃迁至」距离（客户端设置 WarpTo，0 ~ 100 km；选中物体窗口右键跃迁按钮可改），记在本机
const WARP_DISTS = [0, 10000, 20000, 30000, 50000, 70000, 100000];
const WARPD_KEY = 'eve-pilot-warpd';
const warpD = () => { const v = Number(ctx.store.getJSON(WARPD_KEY, 0)); return WARP_DISTS.includes(v) ? v : 0; };
function warpTo(tgt, dist = warpD()) {
  if (!R.warpTo(tgt, dist)) return;
  // 客户端 UI/Drones/WarpWarningMessage
  if (S.me.drones.some((d) => d.pos)) pushLog('你将要跃迁远离你的无人机。', 'bad');
  S.view?.follow?.(S.me.i);
  renderSel();
}
// 天体：总览图标（客户端 brackets 按组）、到表面的距离
const CEL_BRK = { 6: 'sun', 7: 'planet', 8: 'moon', 9: 'asteroidbelt', 10: 'stargate', 15: 'station', 366: 'warpgate' };
const celIcon = (c) => (c.brk ? `${UI}${c.brk}?v=1` : `${UI}shared/brackets/${CEL_BRK[c.group] || 'planet'}.png?v=1`);
const celDist = (u, c) => Math.max(0, Math.hypot(c.pos[0] - u.pos[0], c.pos[1] - u.pos[1], c.pos[2] - u.pos[2]) - (c.radius || 0) - u.t.radius);
function pickCel(i, e) {
  const c = S.b?.cel[i];
  if (!c) return;
  S.sel = -1;
  S.selC = i;
  if (S.keys.has('v')) SC.scanToward(c.pos);   // V + 点击：只朝那个方向扫，镜头不动
  else if (S.keys.has('s')) warpTo({ cel: i });
  else if (S.keys.has('d') && ['gate', 'conduit'].includes(ST.gateOf(i)?.kind)) ST.activate(i);   // D + 点击：激活加速轨道（CmdDockOrJumpOrActivateGate）
  else if (S.keys.has('q')) celApproach(i);
  renderSel();
  renderOverview(true);
}
// 接近天体：飞向它的 0 km 落点
function celApproach(i) {
  const c = S.b.cel[i], u = S.me, off = [u.pos[0] - c.pos[0], u.pos[1] - c.pos[1], u.pos[2] - c.pos[2]], d = Math.hypot(...off) || 1;
  const pt = c.pos.map((x, k) => x + off[k] / d * (c.land || c.radius || 0));
  if (R.cmd({ cmd: 'point', pt, tgt: null })) pushLog(`靠近 ${c.name}`, 'sys');
}
function warpFx() {
  const u = S.me, w = u?.warp;
  if (!u?.alive || !w?.go || !S.b) return null;
  const t = Math.max(0, S.b.t - w.t0), x = w.c.at(Math.min(t, w.c.tE));
  const decel = w.c.tA + w.c.tC;
  return {
    dir: w.dir, sf: x.v / (3 * AU * (u.t.warpMul || 1)),
    fi: Math.min(1, t / 1.5), fo: Math.max(0, Math.min(1, (t - decel) / 1.5)),
    shake: warpShake(x.v, u.t.vel, u.t.warp),
  };
}
// HUD 上方的跃迁提示（客户端 spaceMgr 的 HudActionIndication）：对准时「正在建立跃迁航向」+ 进度条，跃迁中「跃迁引擎启动」；副标题「目的地：…」
function warpInd() {
  const u = S.me, P = u?.pilot;
  let d = null;
  if (u?.alive && u.warp?.go) {
    const w = u.warp, x = w.c.at(Math.max(0, S.b.t - w.t0));
    d = { cap: '跃迁引擎启动', text: `目的地：${w.name || ''}`, dist: Math.max(0, w.D - x.s), warp: true };
  } else if (u?.alive && P.cmd === 'warp' && P.wp) {
    const name = P.wp.cel != null ? S.b.cel[P.wp.cel]?.name : S.names[P.wp.u?.i];
    d = { cap: '正在建立跃迁航向', text: `目的地：${name || ''}`, prog: S.b.alignProgress(u) };
  }
  const was = IND.warp;
  // 标题、目的地没变：沿用原来的对象（提示框只在换内容时重画），只更新进度和剩余距离
  if (d && was && d.cap === was.cap && d.text === was.text) { Object.assign(was, d); d = was; }
  IND.warp = d;
  if (d !== was) indUpdate(d && d.cap !== was?.cap);
  const el = root?.querySelector('#plInd');
  if (el && d && IND.cur === d) {
    const bar = el.querySelector('.pl-ind-bar');
    bar.hidden = d.prog == null;
    if (d.prog != null) bar.firstChild.style.width = `${Math.round(d.prog * 100)}%`;
    el.querySelector('p').textContent = tr(d.text) + (d.dist != null ? `  ${fmtDist(d.dist)}` : '');
  }
}

// ---------- 指令 ----------
function cmd(c) {
  if (!R.cmd(c)) return;
  const v = c.tgt;
  if (c.cmd === 'stop') indTemp('舰船正在停止');
  const what = { stop: '停船', approach: '靠近', orbit: '环绕', keep: '保持距离', dir: '朝选定方向飞行', point: '飞往指定位置' }[c.cmd];
  pushLog(v ? `${what} ${S.names[v.i]}${c.cmd === 'orbit' || c.cmd === 'keep' ? ` · ${fmtDist(c.dist)}` : ''}` : what, 'sys');
  renderSel();
}
const lockUnit = (v) => R.lock(v);
function pickUnit(i, e) {
  if (i < 0) return;
  const v = S.b?.units[i];
  if (!v) return;
  S.sel = i;
  S.selC = -1;
  if (v !== S.me && v.alive) {
    if ((e?.ctrlKey || e?.metaKey) && e?.shiftKey) act('unlock', v);
    else if (e?.ctrlKey || e?.metaKey) lockUnit(v);
    else if (e?.altKey) act('look', v);
    else if (S.keys.has('x') && S.fleet) FL.broadcast('target', { u: v });
    else if (S.keys.has('v')) SC.scanToward(v.pos);   // V + 点击：只朝那个方向扫，镜头不动
    else if (S.keys.has('c')) act('track', v);
    else if (S.keys.has('s')) act('warp', v);
    else if (S.keys.has('q')) cmd({ cmd: 'approach', tgt: v });
    else if (S.keys.has('w')) cmd({ cmd: 'orbit', tgt: v, dist: S.orbit });
    else if (S.keys.has('e')) cmd({ cmd: 'keep', tgt: v, dist: S.keep });
  }
  renderSel();
  renderOverview(true);
}
// 主动装备但驾驶模拟没做（不在可开关列表里）：点了给提示，不再没反应；真正的被动装备客户端点了也没反应
const unsupported = (m) => { const x = S.on?.rack?.[m]; return Boolean(x && !toggleable().has(m) && ctx.data.types.get(x.type)?.activatable); };
const toggleModule = (m, e) => {
  if (S.me?.alive && SC.rackLaunch(m)) return;
  if (S.me?.alive && unsupported(m) && !e?.shiftKey) { const x = S.on.rack[m]; pushLog(`驾驶模拟里暂不支持启动${typeName(x.type)}`, 'bad'); return; }
  R.toggleModule(m, Boolean(e?.shiftKey));
};
const { canActivate, activate, cycleOf, cycStart, toggleable } = R;

// ---------- 点击 ----------
function onClick(e) {
  const t = e.target;
  let x;
  if (S.fleet && t.closest?.('[data-win="fleet"], [data-win="bc"], [data-win="watch"], [data-win="fcomp"]') && FL.fleetClick(e)) return;
  if (S.scan && t.closest?.('[data-win="dscan"], [data-win="probe"]') && SC.scanClick(e)) return;
  if (t.closest?.('[data-win="loot"]') && CG.cargoClick(e)) return;
  if ((x = t.closest('[data-pl-pick]'))) {
    const [who, id] = x.dataset.plPick.split(':');
    if (who === 'me') { S.set.ship = Number(id); S.set.fit = 'kb'; } else if (who === 'ally') { if (S.set.allies.length < 8) S.set.allies.push({ ship: Number(id), fit: 'kb', count: 1 }); } else S.set.foes.push({ ship: Number(id), count: 1 });
    save();
    renderSetup();
    return;
  }
  if ((x = t.closest('[data-pl-drive]'))) { driveAlly(Number(x.dataset.plDrive)); return; }
  if ((x = t.closest('[data-pl-adel]'))) { S.set.allies.splice(Number(x.dataset.plAdel), 1); save(); renderSetup(); return; }
  if (t.closest('[data-pl-mdel]')) { const a = S.set.allies[0]; if (a) { Object.assign(S.set, { ship: a.ship, fit: a.fit }); if (a.count > 1) a.count--; else S.set.allies.shift(); save(); renderSetup(); } return; }
  if ((x = t.closest('[data-pl-del]'))) { S.set.foes.splice(Number(x.dataset.plDel), 1); save(); renderSetup(); return; }
  if ((x = t.closest('[data-pl-preset]'))) { const p = [...PRESETS, ...userPresets()].find((y) => y.id === x.dataset.plPreset); if (p) applyPreset(p); return; }
  if ((x = t.closest('[data-pl-tab]'))) { S.set.tab = x.dataset.plTab; save(); renderSetup(); return; }
  if ((x = t.closest('[data-pl-ptab]'))) { S.set.ptab = x.dataset.plPtab; save(); renderPresets(); return; }
  if ((x = t.closest('[data-pl-ppub]'))) { publishPreset(x.dataset.plPpub); return; }
  if ((x = t.closest('[data-pl-punpub]'))) { unpublishPreset(x.dataset.plPunpub); return; }
  if ((x = t.closest('[data-pl-puse]'))) { usePub(x.dataset.plPuse); return; }
  if (t.closest('[data-pl-preload]')) { PUB.list = null; loadPub(); renderPresets(); return; }
  if ((x = t.closest('[data-pl-msk]'))) { S.set.mskill = x.dataset.plMsk; save(); MH.onState(); return; }
  if ((x = t.closest('[data-pl-mrf]'))) { S.set.mroomf = x.dataset.plMrf; save(); root.querySelectorAll('[data-pl-mrf]').forEach((b) => b.classList.toggle('active', b === x)); MH.onRooms(); return; }
  if ((x = t.closest('[data-pl-mpub]'))) { S.set.mpub = x.dataset.plMpub === '1'; save(); MH.onState(); return; }
  if ((x = t.closest('[data-pl-mjoin]'))) { matchGo('join', x.dataset.plMjoin); return; }
  if ((x = t.closest('[data-pl-pdel]'))) { delPreset(x.dataset.plPdel); return; }
  if (t.closest('[data-pl-psave]')) { savePreset(); return; }
  if ((x = t.closest('[data-pl-view]'))) { viewFit(x.dataset.plView); return; }
  if (t.closest('[data-pl-fvclose]') || t.matches('.pl-fitview')) { S.fitView = null; renderFitView(); return; }
  if (t.closest('[data-pl-fvopen]')) { const d = fitViews.get(S.fitView?.k); if (d?.row?.fit) { S.fitView = null; ctx.openInFitting(ctx.normalize(JSON.parse(JSON.stringify(d.row.fit)))); } return; }
  if ((x = t.closest('[data-pl-sky]'))) { S.set.sky = x.dataset.plSky; save(); renderSetup(); return; }
  if ((x = t.closest('[data-win-open]'))) { toggleWin(x.dataset.winOpen); return; }
  if (t.closest('[data-pl-tac]')) { toggleTac(); return; }
  if (t.closest('[data-win-reset]')) { ctx.store.setJSON(WIN_KEY, {}); placeWins(true); return; }
  if ((x = t.closest('[data-win-close]'))) { toggleWin(x.closest('[data-win]').dataset.win, false); return; }
  if ((x = t.closest('[data-win-lock]'))) { lockWin(x.closest('[data-win]'), !x.closest('[data-win]').classList.contains('locked')); saveWins(); return; }
  if ((x = t.closest('[data-win-min]'))) { const w = x.closest('[data-win]'); w.classList.toggle('min'); if (!w.classList.contains('min')) w.style.height = (Number(w.dataset.h) || 200) + 'px'; saveWins(); return; }
  if ((x = t.closest('[data-pl-drones]'))) { setDrones(x.dataset.plDrones === '1'); return; }
  if ((x = t.closest('[data-pl-dist]'))) { S.set.dist = Number(x.dataset.plDist); save(); renderSetup(); return; }
  if (t.closest('[data-pl-go]')) { launch(); return; }
  const md = t.closest('[data-pl-mode]');
  if (md) { S.set.mode = md.dataset.plMode; if (S.set.mode !== 'free' && ST.siteById(S.set.site)?.kind !== S.set.mode) S.set.site = ST.siteDefault(S.set.mode); save(); renderSetup(); return; }
  if (t.closest('[data-pl-aby-more]')) { ST.toggleAbyssPool(); const box = root.querySelector('#plSites'); if (box) box.innerHTML = ST.siteSetupHtml(S.set.mode, S.set.site, S.set.abyWx); return; }
  const awx = t.closest('[data-pl-aby-wx]');
  if (awx) { S.set.abyWx = awx.dataset.plAbyWx; save(); const box = root.querySelector('#plSites'); if (box) box.innerHTML = ST.siteSetupHtml(S.set.mode, S.set.site, S.set.abyWx); return; }
  const sc = t.closest('[data-pl-site]');
  if (sc) { S.set.site = sc.dataset.plSite; save(); const box = root.querySelector('#plSites'); if (box) box.innerHTML = ST.siteSetupHtml(S.set.mode, S.set.site, S.set.abyWx); return; }
  if ((x = t.closest('[data-pl-tutsel]'))) { S.set.tutSel = x.dataset.plTutsel; save(); renderSetup(); return; }
  if ((x = t.closest('[data-pl-tut]'))) { S.set.tutSel = x.dataset.plTut; save(); S.b = null; launchTut(x.dataset.plTut); return; }
  if ((x = t.closest('[data-pl-mm]'))) { S.set.mmode = x.dataset.plMm; save(); MH.onState(); return; }
  if ((x = t.closest('[data-pl-mc]'))) { S.set.mcap = Number(x.dataset.plMc); save(); MH.onState(); return; }
  if (t.closest('[data-pl-mq]')) { matchGo('queue'); return; }
  if (t.closest('[data-pl-mr]')) { matchGo('room'); return; }
  if (t.closest('[data-pl-mstart]')) { MT.err = ''; matchSend({ op: 'start' }); return; }
  if (t.closest('[data-pl-mj]')) { const code = root.querySelector('[data-pl-mcode]')?.value.trim().toUpperCase(); if (code) matchGo('join', code); return; }
  if (t.closest('[data-pl-mx]')) { matchSend({ op: 'cancel' }); return; }
  if (t.closest('[data-pl-exit]')) {
    // 匹配对战还没结束：认输（船算被击毁），等服务器发结果
    if (S.match && !S.ended) { if (confirm(tr('认输并结束这一局？'))) matchSend({ op: 'leave' }); return; }
    if (S.tut) { S.set.tab = 'tut'; S.tut = null; tutStop(); }
    S.b = null; S.me = null; S.match = null; R = RL; renderSetup(); return;
  }
  if (t.closest('[data-pl-restart]')) { if (S.match) return; S.b = null; if (S.tut) launchTut(S.tut); else launch(); return; }
  if (t.closest('[data-pl-full]')) { toggleFull(); return; }
  if ((x = t.closest('[data-pl-pause]')) && S.match) return;
  if ((x = t.closest('[data-pl-pause]'))) { S.paused = !S.paused; x.textContent = tr(S.paused ? '继续' : '暂停'); x.classList.toggle('on', S.paused); return; }
  if ((x = t.closest('[data-pl-hudopt]'))) { toggleHudMenu(x); return; }
  if ((x = t.closest('[data-pl-hudset]'))) { setHud(x.dataset.plHudset); return; }
  if ((x = t.closest('[data-pl-cm]'))) { runMenu(Number(x.dataset.plCm)); return; }
  if ((x = t.closest('[data-pl-qty]'))) { qtyDone(x.dataset.plQty); return; }
  if ((x = t.closest('[data-pl-drbtn]'))) { const k = x.dataset.plDrbtn; if (k !== 'engage') setDrones(k === 'launch'); return; }
  if ((x = t.closest('[data-pl-drhead]'))) { droneFold(x.dataset.plDrhead); return; }
  if ((x = t.closest('[data-pl-ovl]'))) { if (!S.hud.lockOvl) toggleOverload(Number(x.dataset.plOvl)); return; }
  if ((x = t.closest('[data-pl-rkov]'))) { if (!S.hud.lockOvl) toggleRackOverload(x.dataset.plRkov); return; }
  if (t.closest('[data-pl-grpall]')) { groupAll(); return; }
  if ((x = t.closest('[data-pl-mod]'))) { toggleModule(Number(x.dataset.plMod), e); return; }
  if ((x = t.closest('[data-pl-tgt]'))) { const v = S.b?.units[Number(x.dataset.plTgt)]; if (v) { if (S.me.pilot.locks.has(v)) S.me.pilot.active = v; S.sel = v.i; renderSel(); } return; }
  if ((x = t.closest('[data-pl-act]'))) { if (x.getAttribute('aria-disabled') !== 'true') act(x.dataset.plAct); return; }
  if ((x = t.closest('[data-pl-ovtab]'))) { setOvTab(Number(x.dataset.plOvtab)); return; }
  if ((x = t.closest('[data-pl-ov]'))) { pickUnit(Number(x.dataset.plOv), e); }
  if ((x = t.closest('[data-pl-ovc]'))) { pickCel(Number(x.dataset.plOvc), e); }
}
function onDbl(e) {
  const th = e.target.closest('.pl-ov thead th');
  if (th) { ovAutoFit(th.cellIndex); return; }
  const x = e.target.closest('[data-pl-ov]');
  if (x) { const v = S.b?.units[Number(x.dataset.plOv)]; if (v?.alive && v !== S.me) cmd({ cmd: 'approach', tgt: v }); }
  // 双击天体：150 km 内接近，再远就对准（客户端 menusvc.py：双击按距离决定）
  const c = e.target.closest('[data-pl-ovc]');
  if (c) celDbl(Number(c.dataset.plOvc));
}
function celDbl(i) {
  const cc = S.b?.cel[i], u = S.me;
  if (!cc || !u) return;
  if (celDist(u, cc) < 150000) celApproach(i);
  else { const off = cc.pos.map((x, k) => x - u.pos[k]), l = Math.hypot(...off) || 1; if (R.cmd({ cmd: 'dir', dir: off.map((x) => x / l), tgt: null })) pushLog(`正在朝向${cc.name}`, 'sys'); }
}
function act(a, v = S.selC >= 0 ? null : S.b?.units[S.sel]) {
  if (a === 'stop') { cmd({ cmd: 'stop', tgt: null }); return; }
  if (!v && S.selC >= 0 && S.b?.cel[S.selC]) {
    if (a === 'warp') warpTo({ cel: S.selC });
    if (a === 'approach') celApproach(S.selC);
    if (a === 'gate') ST.activate(S.selC);
    if (a === 'loot') ST.openCargo(S.selC);
    renderSel();
    return;
  }
  if (!v || v === S.me || !v.alive) return;
  if (a === 'approach') cmd({ cmd: 'approach', tgt: v });
  if (a === 'warp') warpTo(v);
  if (a === 'orbit') cmd({ cmd: 'orbit', tgt: v, dist: S.orbit });
  if (a === 'keep') cmd({ cmd: 'keep', tgt: v, dist: S.keep });
  if (a === 'lock') lockUnit(v);
  if (a === 'unlock') R.unlock(v);
  if (a === 'look') S.view?.follow(v.i);
  if (a === 'look0') S.view?.follow(S.me?.i ?? 0);
  if (a === 'track') S.view?.track?.(S.view.tracking?.() === v.i ? -1 : v.i);
  renderSel();
}
function onKey(e) {
  if (!S.b || !active() || !root.querySelector('#plStage')) return;
  if (e.type === 'keydown' && FL.fleetInputKey(e)) return;
  if (e.target.closest?.('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'control') { S.ctrl = e.type === 'keydown'; cursorMode(); return; }
  if (e.type === 'keyup') { S.keys.delete(k); if (k === 'q' && S.mv?.state === 'xz') mvAbort(); SC.scanKeyUp(k); cursorMode(); return; }
  if (!e.repeat && SC.scanKey(e, k)) return;
  if (['c', 's', 'd'].includes(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { S.keys.add(k); return; }
  // 舰队快捷键（客户端默认）：Z 广播发现敌舰；按住 X 点目标 = 广播锁定
  if (S.fleet && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && FL.fleetKey(k)) return;
  if (S.fleet && k === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey) { S.keys.add(k); return; }
  if (['q', 'w', 'e'].includes(k) && !e.ctrlKey && !e.metaKey) { S.keys.add(k); if (k === 'q' && S.mxy && !S.mv) mvStart(); cursorMode(); return; }
  if (k === 'd' && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); toggleTac(); return; }
  if (e.shiftKey && k === 'f') { e.preventDefault(); setDrones(true); return; }
  if (e.shiftKey && k === 'r') { e.preventDefault(); setDrones(false); return; }
  if (k === ' ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cmd({ cmd: 'stop', tgt: null }); return; }
  // 舰船模式：Shift + 1 / 2 / 3（客户端 CmdSetDefenceStance / CmdSetSniperStance / CmdSetSpeedStance）
  const sd = /^Digit([1-3])$/.exec(e.code || '');
  if (sd && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && S.modes?.length) { e.preventDefault(); setMode(Number(sd[1]) - 1); return; }
  // F1–F8 高槽，Alt + F1–F8 中槽，Ctrl + F1–F8 低槽（和游戏一样）
  const f = /^f([1-8])$/.exec(k);
  if (f) {
    e.preventDefault();
    const slot = e.altKey ? 'mid' : e.ctrlKey ? 'low' : 'high';
    const hit = S.rk?.order[slot]?.[Number(f[1]) - 1];
    if (hit != null && hit >= 0) toggleModule(hit, { shiftKey: e.shiftKey });
  }
}
// 速度表：点下半圈按位置设速度（左下 0、右下全速，两头 5% 以内吸到 0 / 全速）；左右的 − / + 是停船和全速
function setSpeed(frac) {
  const P = S.me?.pilot;
  if (!P) return;
  if (frac <= 0) { cmd({ cmd: 'stop', tgt: null }); return; }
  R.setSpeed(frac);
  if (frac >= 1) { const v = S.me.t.vel * S.me.velMult; indTemp('舰船全速设置', `速度变为${v >= 100 ? Math.floor(v).toLocaleString('en-US') : v.toFixed(2)} m/s`); }
}
function onHudClick(e) {
  // 货舱和挂舱按钮：开 / 关货柜舱窗口
  if (e.target.closest('[data-pl-cargobtn]')) { toggleWin('cargo'); return; }
  // 扫描器按钮：选定向扫描器 / 探针扫描器
  if (e.target.closest('[data-pl-scanbtn]')) { hideHint(); closeMenus(); S.cm = [['定向扫描器 (Alt + D)', () => toggleWin('dscan', true)], ['探针扫描器 (Alt + P)', () => toggleWin('probe', true)]]; cmenuAt(e); return; }
  const st = e.target.closest('[data-pl-stance]');
  if (st) { setMode(Number(st.dataset.plStance)); return; }
  const b = e.target.closest('[data-pl-spd]');
  if (b) { setSpeed(b.dataset.plSpd === 'max' ? 1 : 0); return; }
  const c = root.querySelector('#plHudC'), r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * HUD.W - HUD.cx, y = (e.clientY - r.top) / r.height * HUD.H - (HUD.cy - 1);
  if (y < 22 || Math.hypot(x, y) > 74) return;
  const f = (45 + Math.atan(x / y) * 180 / Math.PI) / 90;
  setSpeed(f < 0.05 ? 0 : f > 0.95 ? 1 : f);
}

// 船体面板悬停提示：电容（CapacitorContainer.LoadTooltipPanel，pickRadius 30）、护盾 / 装甲 / 结构（HpGauges.LoadDamageTooltip，
// shieldGauge pickRadius 74；下半圈是速度表 pickRadius 72，那里不出）。三列：图标、标题 + 「当前 / 最大」、百分比（16 号粗体），10 毫秒刷新
function hudHit(e) {
  const c = root.querySelector('#plHudC'), r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * HUD.W - HUD.cx, y = (e.clientY - r.top) / r.height * HUD.H - (HUD.cy - 1);
  const d = Math.hypot(x, y);
  if (d <= 30) return 'cap';
  if (y >= 22 && d <= 72) return null;
  return d <= 74 ? 'hp' : null;
}
let hudTipTimer = 0;
function onHudMove(e) {
  const k = S.me ? hudHit(e) : null;
  if (k === (S.htip?.k ?? S.htipWait)) return;
  hideHudTip();
  if (!k) return;
  S.htipWait = k;
  hudTipTimer = setTimeout(() => showHudTip(k), 200);
}
function hideHudTip() {
  clearTimeout(hudTipTimer);
  S.htip = null; S.htipWait = null;
  root?.querySelector('.pl-htip')?.remove();
}
const HUD_TIP_ROWS = { cap: [['1_64_1', 40, '电容']], hp: [['1_64_13', 36, '护盾'], ['1_64_9', 36, '装甲'], ['2_64_12', 36, '结构']] };
function showHudTip(k) {
  const stage = root.querySelector('#plStage'), c = root.querySelector('#plHudC');
  if (!stage || !c || !S.me) return;
  const el = document.createElement('div');
  el.className = 'pl-htip';
  el.innerHTML = `<div class="b">${HUD_TIP_ROWS[k].map(([ic, sz]) => `<div class="r"><img src="${UI}icons/${ic}.png?v=1" alt="" width="${sz}" height="${sz}"><span></span><em></em></div>`).join('')}</div><i class="ptr"></i>`;
  stage.appendChild(el);
  S.htip = { k, el };
  updHudTip();
  // 在圆的正上方居中，指针朝下
  const st = stage.getBoundingClientRect(), r = c.getBoundingClientRect();
  const sc = r.width / HUD.W, ox = r.left - st.left + HUD.cx * sc, oy = r.top - st.top + (HUD.cy - 1 - (k === 'cap' ? 30 : 74)) * sc;
  const x = Math.max(4, Math.min(st.width - el.offsetWidth - 4, ox - el.offsetWidth / 2));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(oy - el.offsetHeight - 8)}px`;
  el.querySelector('.ptr').style.left = `${Math.round(ox - x - 12)}px`;
}
function updHudTip() {
  const h = S.htip, u = S.me;
  if (!h || !u) return;
  const n = (v) => Math.round(Math.max(0, v)).toLocaleString('en-US'), pct = (f) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
  const vals = h.k === 'cap'
    ? [[u.cap, u.t.cap.max || 0]]
    : [0, 1, 2].map((l) => [u.hp[l], u.t.max[l] || 0]);
  h.el.querySelectorAll('.r').forEach((row, i) => {
    const [cur, max] = vals[i], name = esc(tr(HUD_TIP_ROWS[h.k][i][2]));
    const txt = `<b>${name}</b><br>${n(Math.min(cur, max))} / ${n(max)}`, p = pct(max ? cur / max : 0);
    if (row.children[1].innerHTML !== txt) row.children[1].innerHTML = txt;
    if (row.children[2].textContent !== p) row.children[2].textContent = p;
  });
}

// ---------- 船体面板：照客户端 shipHud 的贴图和坐标拼 ----------
// 画布 360×200，圆心 (180, 100)；客户端中间这块是 185×200，左边多留出护盾/装甲/结构读数的位置
const HUD = { W: 360, H: 200, cx: 180, cy: 100, k: 2 };
// 电容格的光：客户端是橙色 (0.94, 0.35, 0.2) 叠加发光，画面上偏黄橙，这里直接取录像里的颜色
const SMOKE_BLUE = '#305665', CAP_ORANGE = [1, 0.7, 0.33], CAP_DARK = [70 / 256, 26 / 256, 13 / 256];
// 贴图乘色（客户端 Sprite 的 color：贴图 rgb × 颜色，透明度不变）
const mulCache = new Map();
function mulTex(path, color) {
  const im = tex(path);
  if (!ready(im)) return null;
  const k = path + '*' + color;
  if (!mulCache.has(k)) {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(im, 0, 0);
    mulCache.set(k, c);
  }
  return mulCache.get(k);
}
// 护盾 / 装甲 / 结构弧：刻度贴图 × 旋转后的 gaugeFill（上白下红），转角 π(1 − 剩余比例)，掉血从右端开始变红
const gaugeBuf = document.createElement('canvas');
function gauge(x, name, v, cx, cy) {
  const g = tex(`classes/shipui/${name}.png`), fill = tex('classes/shipui/gaugefill.png');
  if (!ready(g) || !ready(fill)) return;
  const S2 = 148 * HUD.k;
  if (gaugeBuf.width !== S2) { gaugeBuf.width = S2; gaugeBuf.height = S2; }
  const b = gaugeBuf.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.clearRect(0, 0, S2, S2);
  b.save();
  b.translate(S2 / 2, S2 / 2);
  b.rotate(-Math.PI * (1 - Math.max(0, Math.min(1, v))));
  b.imageSmoothingEnabled = false;
  b.drawImage(fill, -S2 * 0.75, -S2 * 0.75, S2 * 1.5, S2 * 1.5);   // 放大铺满，等同贴图坐标越界取边缘色
  b.restore();
  b.imageSmoothingEnabled = true;
  b.globalCompositeOperation = 'multiply';
  b.drawImage(g, 0, 0, S2, S2);
  b.globalCompositeOperation = 'destination-in';
  b.drawImage(g, 0, 0, S2, S2);
  // 阴影：往下 1 像素的黑色一层
  const sh = mulTex(`classes/shipui/${name}.png`, '#000');
  if (sh) { x.globalAlpha = 0.8; x.drawImage(sh, cx - 74, cy - 73, 148, 148); x.globalAlpha = 1; }
  x.drawImage(gaugeBuf, cx - 74, cy - 74, 148, 148);
}
// 船体面板的血量环（客户端 shipHud/hpGauges.py）：shipUI.UpdateGauges 每 0.5 秒取一次真实血量，
// ShipHudSpriteGauge.AnimGauge 从上次取到的值 MorphScalar 到新值，0.5 秒，默认曲线 ANIM_SMOOTH（Hermite 零切线 = smoothstep）；第一次直接设
const smooth = (t) => t * t * (3 - 2 * t);
function hudHp(u, hp) {
  const now = performance.now();
  let G = S.hpG;
  if (!G || G.u !== u) G = S.hpG = { u, at: -1e9, last: null, from: hp, to: hp, t0: now };
  if (now - G.at >= 500) {
    G.at = now;
    G.from = G.last || hp;
    G.to = hp;
    G.t0 = now;
    G.last = hp;
  }
  const t = smooth(Math.min(1, (now - G.t0) / 500));
  return G.from.map((a, l) => a + (G.to[l] - a) * t);
}
// 目标栏的血弧（客户端 targetInBar.py TargetHealthBars）：每个目标一个 750–1000 毫秒（随机，建好时定下）的计时器取血量；
// SetDamage：上次的值不为 0 时线性动画，时长 max(0.1, 0.4 × 变化量) 秒，从现在显示的位置开始；上次为 0 或第一次直接设
const tgtHpG = new WeakMap();
const animAt = (a, now) => (a.d ? a.from + (a.to - a.from) * Math.min(1, (now - a.t0) / a.d) : a.to);
function tgtHp(v, hp) {
  const now = performance.now();
  let G = tgtHpG.get(v);
  if (!G) { G = { at: now, iv: 750 + Math.random() * 250, last: hp, a: hp.map((f) => ({ from: f, to: f, t0: now, d: 0 })) }; tgtHpG.set(v, G); }
  else if (now - G.at >= G.iv) {
    G.at = now;
    G.a = hp.map((f, l) => (G.last[l] ? { from: animAt(G.a[l], now), to: f, t0: now, d: Math.max(100, 400 * Math.abs(f - G.last[l])) } : { from: f, to: f, t0: now, d: 0 }));
    G.last = hp;
  }
  return G.a.map((a) => animAt(a, now));
}
function drawHud() {
  const c = root.querySelector('#plHudC'), u = S.me;
  if (!c || !u) return;
  const { W, H, k, cx, cy } = HUD;
  if (c.width !== W * k) { c.width = W * k; c.height = H * k; }
  const x = c.getContext('2d');
  x.setTransform(k, 0, 0, k, 0, 0);
  x.clearRect(0, 0, W, H);
  const put = (im, w, h, dx, dy) => { if (im && (im instanceof HTMLCanvasElement || ready(im))) x.drawImage(im, dx, dy, w, h); };
  const hp = [0, 1, 2].map((l) => (u.t.max[l] ? Math.max(0, Math.min(1, u.hp[l] / u.t.max[l])) : 0));
  // 读数：左边三行百分比 + 一条横线拉到圆心正上方（客户端 HudReadout，行高 14，从 22 开始）。
  // 客户端默认不显示（showReadout 默认 0，要在船体面板菜单里勾），这里也默认不画；具体数值看鼠标悬停提示
  x.font = '11px "EVE Sans Neue", system-ui, sans-serif';
  x.textAlign = 'right';
  x.textBaseline = 'top';
  if (S.hud.readout) hp.forEach((f, l) => {
    const y = 22 + l * 14;
    x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(cx - 124 + 4, y + 6, 124 - 4, 1);
    x.fillStyle = 'rgba(26,26,26,0.5)'; x.fillRect(cx - 124 + 4, y + 7, 124 - 4, 1);
    x.fillStyle = f < 0.25 ? '#ff454b' : 'rgba(255,255,255,0.75)';
    x.shadowColor = 'rgba(0,0,0,0.8)'; x.shadowBlur = 2;
    x.fillText(S.hud.pct ? `${Math.round(f * 100)}%` : `${Math.round(Math.max(0, u.hp[l])).toLocaleString('en-US')} / ${Math.round(u.t.max[l]).toLocaleString('en-US')}`, cx - 124, y);
    x.shadowBlur = 0;
  });
  // 底圈（黑 0.3）+ 主体外壳（主题色 #305665 乘色）
  x.globalAlpha = 0.3; put(mulTex('classes/shipui/mainbgcircle.png', '#000'), 160, 160, cx - 80, cy - 80); x.globalAlpha = 1;
  // 外壳：主题色乘上去后在游戏里几乎是黑的，只有边缘一圈泛青
  put(mulTex('classes/shipui/mainunderlay.png', '#1d2a30'), 160, 160, cx - 80, cy - 80);
  // 热量表：三段底板（按热量换 0–4 号）+ 分隔 + 指针（起点 低 -2° / 中 -62° / 高 -122°，满热转 56°，0.5 秒跟上）
  const hx = cx - 80, hy = cy - 80;
  const hs = S.rk?.h || [0, 0, 0];
  S.hNeedle = S.hNeedle || [0, 0, 0];
  const hIdx = (v) => (v <= 1 / 8 ? 0 : v <= 3 / 8 ? 1 : v <= 5 / 8 ? 2 : v <= 7 / 8 ? 3 : 4);
  put(tex('classes/shipui/heatdivider.png'), 46, 12, hx + 56, hy + 42);
  put(tex(`classes/shipui/lowheat_${hIdx(hs[2])}.png`), 27, 38, hx + 36, hy + 42);
  put(tex(`classes/shipui/medheat_${hIdx(hs[1])}.png`), 45, 18, hx + 57, hy + 36);
  put(tex(`classes/shipui/hiheat_${hIdx(hs[0])}.png`), 27, 38, hx + 95, hy + 42);
  const needle = tex('classes/shipui/heatgaugeneedle.png');
  if (ready(needle)) [[-2, 2], [-62, 1], [-122, 0]].forEach(([deg, r]) => {
    S.hNeedle[r] += (hs[r] - S.hNeedle[r]) * 0.08;
    x.save(); x.translate(cx - 1, cy); x.rotate(-(deg - 56 * S.hNeedle[r]) * Math.PI / 180); x.drawImage(needle, -41.5, -6, 12, 12); x.restore();
  });
  // 护盾（外）/ 装甲 / 结构（内）
  const hpA = hudHp(u, hp);
  gauge(x, 'gauge3', hpA[2], cx, cy);
  gauge(x, 'gauge2', hpA[1], cx, cy);
  gauge(x, 'gauge1', hpA[0], cx, cy);
  // 电容：最多 18 列（每 50 GJ 一列），每列 4 格由外到内渐小；点亮的格子发橙光，空格灰色半透明。
  // 从最后一列往回点亮，电容掉的时候从正上方那列开始顺时针变暗；最边上那格一闪一闪
  const capMax = u.t.cap.max || 0;
  const prop = capMax ? Math.max(0, Math.min(1, Math.round(u.cap / capMax * 100) / 100)) : 0;
  const ncol = Math.max(1, Math.min(18, Math.floor(capMax / 50)));
  const total = ncol * 4, vis = Math.max(0, Math.min(total, Math.floor(prop * total)));
  const glow = CAP_ORANGE.map((g, i) => Math.round((g * prop + CAP_DARK[i] * (1 - prop)) * 255));
  const onC = mulTex('classes/shipui/capacitorcell_2.png', `rgb(${glow.join(',')})`);
  const offC = mulTex('classes/shipui/capacitorcell_2.png', '#808080');
  const dark = mulTex('classes/shipui/capacitorcell_2.png', '#000');
  const blinkJ = vis > 0 && vis < total ? total - vis : -1;
  for (let col = 0; col < ncol; col++) {
    x.save();
    x.translate(cx, cy - 1);
    x.rotate(col * 2 * Math.PI / ncol);
    for (let ci = 0; ci < 4; ci++) {
      const j = col * 4 + ci, w = 10 - ci * 2, top = -28 + ci * 5;
      if (j >= total - vis) {
        if (dark) x.drawImage(dark, -w / 2, top + 1, w, 7);
        if (onC) { x.globalCompositeOperation = 'lighter'; x.drawImage(onC, -w / 2 - 1, top - 0.5, w + 2, 8); x.drawImage(onC, -w / 2, top, w, 7); x.globalCompositeOperation = 'source-over'; }
      } else if (offC) { x.globalAlpha = 0.5; x.drawImage(offC, -w / 2, top, w, 7); x.globalAlpha = 1; }
      if (j === blinkJ) {
        const gl = mulTex('classes/shipui/capacitorcellglow.png', `rgb(${CAP_ORANGE.map((g) => Math.round(g * 255)).join(',')})`);
        if (gl) { x.globalCompositeOperation = 'lighter'; x.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 750 * Math.PI * 2); x.drawImage(gl, -(w + 3) / 2, top, w + 3, 7); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; }
      }
    }
    x.restore();
  }
  // 速度表：底座（黑 0.8）+ 跟指针一起转的半圈（#305665，0.8），只露出下面 124×42 这一条；指针 45° 到 135°
  const v = Math.hypot(...u.vel), vmax = u.t.vel * u.velMult;
  const sp = vmax ? Math.min(1, v / vmax) : 0;
  const und = tex('classes/shipui/speedounderlay.png');
  if (ready(und)) { x.globalAlpha = 0.8; put(mulTex('classes/shipui/speedounderlay.png', '#000'), 104, 44, cx - 52, cy - 1 + 48 - 22); x.globalAlpha = 1; }
  x.save();
  x.beginPath(); x.rect(cx - 62, cy + 29, 124, 42); x.clip();
  x.translate(cx, cy + 1);
  x.rotate(-(45 + 90 * sp) * Math.PI / 180);
  const ov = mulTex('classes/shipui/speedooverlay_v2.png', SMOKE_BLUE);
  if (ov) { x.globalAlpha = 0.8; x.drawImage(ov, -75, -90, 153, 89); x.globalAlpha = 1; }
  const nd = mulTex('classes/shipui/heatgaugeneedle.png', '#b0b0b0');
  if (nd) x.drawImage(nd, -67, -6, 24, 12);
  x.restore();
  x.font = '11px "EVE Sans Neue", system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.shadowColor = 'rgba(0,0,0,0.8)'; x.shadowBlur = 2;
  // 跃迁中：客户端速度表写「（正在跃迁）」（UI/Inflight/WarpSpeedNotification），悬停提示里是速度
  x.fillText(u.warp?.go ? tr('（正在跃迁）') : v < 100 ? `${v.toFixed(1)} m/s` : `${Math.round(v)} m/s`, cx, cy + 52);
  x.shadowBlur = 0;
  // 悬停提示：电容 / 三层血量的具体数值（客户端是鼠标提示）
  if (!S.hudTipAt || performance.now() - S.hudTipAt > 500) {
    S.hudTipAt = performance.now();
    const n = (a) => Math.round(Math.max(0, a)).toLocaleString('en-US');
    c.title = `${tr('电容')} ${n(u.cap)} / ${n(capMax)} GJ (${Math.round(prop * 100)}%)\n${tr('护盾')} ${n(u.hp[0])} / ${n(u.t.max[0])}\n${tr('装甲')} ${n(u.hp[1])} / ${n(u.t.max[1])}\n${tr('结构')} ${n(u.hp[2])} / ${n(u.t.max[2])}`;
  }
}

// ---------- 船体面板选项（客户端 shipUI.GetHUDOptionMenu，UtilMenu）----------
// 按钮在 overlayContainer（256×256，居中在船体面板中心）的 (190, 194)，16×16，图标 icons/73_16_50；菜单在按钮上方、左对齐
const HUD_OPTS = [['passive', '显示被动装备'], ['empty', '显示空槽位'], ['readout', '显示读数'], ['pct', '以百分比显示读数', 'readout'], ['tips', '显示装备提示信息'], null, ['lockMods', '锁定装备位置'], ['lockOvl', '锁定超载状态']];
const EMPTY_SLOT = ['空缺的高槽位', '空缺的中槽位', '空缺的低槽位'];
const EMPTY_ICON = ['8_64_11', '8_64_10', '8_64_9'];   // 客户端 ui_8_64_11 / 10 / 9，24×24、透明 0.25
const slotCount = (r) => S.calc?.ship?.attr({ high: 14, mid: 13, low: 12 }[r]) || 0;
// 装备当前装的弹药（右键换过的按换过的）
const chargeOf = (i) => S.charges?.[i] ?? S.on?.rack[i]?.charge ?? 0;
function closeMenus() {
  root?.querySelector('.pl-umenu')?.remove();
  for (const m of root?.querySelectorAll('.pl-cmenu') || []) m.remove();
  S.cm = null;
}
const hudMenuHtml = () => HUD_OPTS.map((o) => (!o ? '<hr>' : `<button type="button" class="pl-um-e${o[2] && !S.hud[o[2]] ? ' off' : ''}" data-pl-hudset="${o[0]}"><img src="${UI}classes/utilmenu/checkbox${S.hud[o[0]] ? 'active' : 'inactive'}.png?v=1" alt=""><span>${o[1]}</span></button>`)).join('');
function toggleHudMenu(btn) {
  const had = root.querySelector('.pl-umenu');
  closeMenus();
  hideTip();
  if (had) return;
  const stage = root.querySelector('#plStage');
  const m = document.createElement('div');
  m.className = 'pl-umenu';
  m.innerHTML = hudMenuHtml();
  stage.appendChild(m);
  const st = stage.getBoundingClientRect(), b = btn.getBoundingClientRect();
  m.style.left = `${Math.round(b.left - st.left)}px`;
  m.style.top = `${Math.round(b.top - st.top - m.offsetHeight - 8)}px`;
}
function setHud(k) {
  const o = HUD_OPTS.find((x) => x && x[0] === k);
  if (!o || (o[2] && !S.hud[o[2]])) return;
  S.hud[k] = S.hud[k] ? 0 : 1;
  ctx.store.setJSON(HUD_KEY, S.hud);
  const m = root.querySelector('.pl-umenu');
  if (m) m.innerHTML = hudMenuHtml();
  if (!S.hud.tips) hideTip();
  if (!['readout', 'pct'].includes(k)) renderRack();
}

// ---------- 装备提示（客户端 ModuleButtonTooltip：4 列，图标 + 文字，每行最低 30，每秒刷新）----------
const fmtN = (v, d = 0) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSec = (s) => `${+Number(s).toFixed(2)}秒`;
const ICO = (n) => `${UI}icons/${n}.png?v=1`;
// 伤害类型：电磁、热能、动能、爆炸（属性 114 / 118 / 117 / 116 的图标与名称）
const DMG_ATTR = [['22_32_12', '电磁伤害'], ['22_32_10', '热能伤害'], ['22_32_9', '动能伤害'], ['22_32_11', '爆炸伤害']];
// 抗性加成：电磁、爆炸、动能、热能（RESISTANCE_BONUS_ATTRIBUTES 984 / 985 / 986 / 987）
const RES_ATTR = [[984, '22_32_12', '电磁伤害抗性加成'], [985, '22_32_11', '爆炸伤害抗性加成'], [986, '22_32_9', '动能伤害抗性加成'], [987, '22_32_10', '热能伤害抗性加成']];
// 装备在算好的装配里对应的那件（取带技能加成后的属性）
// 超载中的装备：取「这件超载」时算出来的属性（客户端提示读的是超载效果生效后的 dogma 属性）
const calcMod = (i) => {
  const k = S.on.rack[i]?.key, ch = chargeOf(i), ov = Boolean(S.rk?.ovl.has(i));
  // 超载、换了弹药、换了舰船模式：按现在的状态重算（弹药改射程 / 伤害 / 跟踪等，提示要跟着变）
  const dirty = ov || (ch && ch !== S.on.rack[i]?.charge) || Boolean(S.mode);
  const c = dirty && S.ovCalc ? S.ovCalc(k, ch, S.mode || undefined, ov) : S.calc;
  return c?.modules.find((m) => `${m.slot}:${m.index}` === k) || null;
};
const shortcutOf = (i) => { const p = posOf(masterOf(i)); return p ? (p[0] === 'high' ? `F${p[1] + 1}` : p[0] === 'mid' ? `Alt-F${p[1] + 1}` : `Ctrl-F${p[1] + 1}`) : ''; };
function ammoLeft(i) {
  const u = S.me;
  for (const [list, st] of [[u.t.guns, u.guns], [u.t.injectors || [], u.inj], [u.t.localReps || [], u.lrep]]) {
    const k = list.findIndex((x) => x.m === i);
    if (k >= 0 && st?.[k]) return st[k].reloadUntil > S.b.t ? 0 : Number.isFinite(st[k].ammo) ? st[k].ammo : null;
  }
  return null;
}
function modTipHtml(i) {
  const u = S.me, rk = S.on.rack[i], t = ctx.data.types.get(rk.type);
  const cm = calcMod(i), A = (id) => cm?.attr(id) ?? t?.attrs.get(id) ?? 0;
  const n = members(i).filter((x) => !S.rk.burnt.has(x)).length || 1;
  const rows = [];
  const row = (icon, text, extra = '', cls = '') => rows.push(`<div class="r${cls}">${icon ? `<img src="${icon}" alt="">` : '<i></i>'}<span>${text}</span>${extra}</div>`);
  const perTime = (icon, label, amount) => row(icon, label.replace('{d}', fmtSec(A(73) / 1000)).replace('{a}', fmtN(amount)));
  const pct = (icon, v, name) => row(ICO(icon), `${fmtN(v)}% ${name}`);
  const active = toggleable().has(i);
  // 名字（编组的写「N x 名字」）+ 快捷键
  const sc = active ? shortcutOf(i) : '';
  row(IMG(rk.type, 'icon', 32), `<b>${n > 1 ? `${n}x ` : ''}${esc(typeName(rk.type))}</b>`, sc ? `<kbd>${sc}</kbd>` : '', ' big');
  // 弹药：数量 + 名字（晶体只写名字）
  const chargeable = ctx.FE.AT.chargeGroups.some((a) => t?.attrs.get(a));
  const ch = chargeOf(i), ct = ch ? ctx.data.types.get(ch) : null;
  const qty = ch ? (ammoLeft(i) ?? ctx.FE.chargeCount(t, ct)) : 0;
  if (ct && qty) row(IMG(ch, 'icon', 32), (ct.attrs.get(783) || 0) > 0 ? `<b>${esc(typeName(ch))}</b>` : `${fmtN(qty)} ${esc(typeName(ch))}`, '', ' big');
  // 射程
  const gk = u.t.guns.findIndex((g) => g.m === i), g = gk >= 0 ? u.t.guns[gk] : null;
  const launcher = g && !g.turret, turret = Boolean(t?.turret) || (g && g.turret);
  // 武器的射程取当前在用的属性（u.t 随弹药 / 模式 / 开关的装备重算）
  // 再乘引擎里的实时系数（跟踪干扰 / 制导干扰、深渊塔和气云）—— 客户端提示显示的是被这些效果改过的属性
  const gt = g && g.turret && !g.vorton, M = (k) => u[k] ?? 1;
  const range = launcher ? g.reach * M('mvelMult') * M('flightMult') : gt ? g.opt * M('optMult') : A(ctx.FE.AT.maxRange);
  const fall = gt ? g.fall * M('fallMult') : turret ? A(ctx.FE.AT.falloff) : A(2044);
  if (range > 0) {
    const R = fmtDist(range), F = fmtDist(range + fall);
    const txt = launcher ? `最大飞行距离<br>${R}` : turret ? (fall > 1 ? `有效距离 ${F}<br>最佳距离 ${R}` : `最佳射程 ${R}`) : t?.group === 72 ? `效果范围 ${R}` : fall > 1 ? `有效距离 ${F}<br>最佳距离 ${R}` : `有效距离 ${R}`;
    row(ICO('22_32_15'), txt);
  }
  // 每秒伤害 + 伤害类型（武器有弹药时）
  if (g && chargeable && !g.doomsday) {
    // 超载：伤害 × (1 + overloadDamageModifier)、周期 × (1 + overloadRofBonus)（和 sim-engine 开火一致）
    const ov = S.rk.ovl.has(i), dk = ov ? 1 + (g.ovD || 0) : 1, ck = ov ? 1 + (g.ovR || 0) : 1;
    const dps = g.volley * dk / (g.cycle * ck) * n, max = g.spool ? dps * g.spool.max : 0;
    row(ICO(launcher ? '81_64_16' : '26_64_1'), max ? `每秒伤害为${fmtN(dps, 1)}-${fmtN(max, 1)}` : `DPS ${fmtN(dps, 1)}`);
    const dm = g.dmg.map((x, k) => [k, x * n * dk]).filter(([, x]) => x > 0);
    if (dm.length === 1) row(ICO(DMG_ATTR[dm[0][0]][0]), `${fmtN(dm[0][1])} HP ${DMG_ATTR[dm[0][0]][1]}`);
    else if (dm.length) { row('', '伤害输出', '', ' head'); rows.push(`<div class="r vals"><i></i><span>${dm.map(([k, x]) => `<em><img src="${ICO(DMG_ATTR[k][0])}" alt="">${fmtN(x)} HP</em>`).join('')}</span></div>`); }
  }
  // 按装备组的附加信息
  const grp = t?.group;
  if (grp === 68) perTime(ICO('1_64_7'), '每{d}吸取{a}点', A(90));
  else if (grp === 71) perTime(ICO('2_64_7'), '每{d} 中和{a} GJ', A(97));
  else if (grp === 62 || grp === 1199) perTime(ICO('1_64_11'), '每{d} 修复{a} HP', A(84) * (ch && grp === 1199 ? A(1886) || 1 : 1));
  else if (grp === 63) perTime(ICO('1_64_11'), '每{d} {a} HP', A(83));
  else if (grp === 40 || grp === 1156) row(ICO('22_32_7'), '每{d} 增加{a} HP'.replace('{d}', fmtSec(A(73) * (u.sbDur ?? 1) / 1000)).replace('{a}', fmtN(A(68) * (u.sbAmt ?? 1))));   // 纤维云：回充量 / 周期（引擎 sbAmt / sbDur）
  else if (grp === 41) perTime(ICO('22_32_7'), '每{d} 传输{a} HP', A(68));
  else if (grp === 325) perTime(ICO('1_64_11'), '每{d} 修复{a} HP', A(84));
  else if (grp === 585) perTime(ICO('1_64_11'), '每{d} {a} HP', A(83));
  else if (grp === 213 || grp === 209) {
    row(ICO('22_32_23'), `失准范围加成：${fmtN(A(349))}%`);
    row(ICO('22_32_15'), `最佳射程加成：${fmtN(A(351))}%`);
    row(ICO('22_32_22'), `跟踪速度加成：${fmtN(A(767))}%`);
  } else if (grp === 46 && S.prop >= 0) {
    const off = S.auto.filter((x) => !S.me.pilot.on.has(x) && x !== S.prop);
    const v0 = S.variant([...off, S.prop], S.charges || {}, S.mode || undefined).vel * u.velMult;
    let v1 = S.variant(off, S.charges || {}, S.mode || undefined).vel * u.velMult;
    if (S.rk.ovl.has(S.prop)) v1 = v0 + (v1 - v0) * (1 + (S.rk.heat[S.prop]?.spd || 0));   // 超载：速度加成那一段按 overloadSpeedFactorBonus 放大（同 pilot-rules）
    row(ICO('22_32_13'), `停用时最大速度：${fmtN(v0, 1)} m/s<br>启用时最大速度：${fmtN(v1, 1)} m/s`);
  } else if (grp === 65) row(ICO('22_32_13'), `降低目标舰船速度 ${fmtN(Math.abs(A(20)))}%`);
  else if (grp === 52) row(ICO('4_64_9'), `跃迁干扰强度：${fmtN(A(105))}`);
  else if (grp === 76 && ct) row(ICO('2_64_7'), `每${fmtSec(A(73) / 1000)} ${fmtN(ct.attrs.get(67) || 0)} GJ`);
  else if ([77, 328, 98, 295, 326].includes(grp)) {
    const v = RES_ATTR.map(([a, ic, nm]) => [A(a), ic, nm]).filter(([x]) => x);
    if (v.length === 1) pct(v[0][1], v[0][0], v[0][2]);
    else if (v.length) { row('', '抗性加成：', '', ' head'); rows.push(`<div class="r vals"><i></i><span>${v.map(([x, ic]) => `<em><img src="${ICO(ic)}" alt="">${fmtN(x, 1)}%</em>`).join('')}</span></div>`); }
  } else if (grp === 201) {
    const L = [[238, '引力ECM干扰强度'], [239, '光雷达ECM干扰强度'], [240, '磁力ECM干扰强度'], [241, '雷达ECM干扰强度']].filter(([a]) => A(a)).map(([a, nm]) => `${fmtN(A(a), 1)} ${nm}`);
    row(ICO('4_64_12'), L.join('<br>'));
  } else if ([212, 208, 290].includes(grp)) {
    if (A(566)) pct('3_64_9', A(566), '扫描分辨率加成');
    if (A(309)) pct('22_32_15', A(309), '最大锁定范围加成');
  } else if (grp === 379) pct('22_32_14', A(554), '信号半径修正值');
  // 跟踪速度
  if (A(160)) row(ICO('22_32_22'), `炮台跟踪速度: ${fmtN(A(160) * (turret ? u.trackMult ?? 1 : 1), 2)}`);   // 跟踪干扰、深渊追踪塔
  // 状态（客户端 GetTextForCurrentStateForDogmaItem：颜色 主动 (0.55,0.87,0.13)、过载 (1,0.17,0.15)、在线 0.6 灰）
  const on = S.me.pilot.on.has(i), ovl = S.rk.ovl.has(i);
  const [txt, col] = !active ? ['启用被动装备', '#999'] : on ? (ovl ? ['过载的装备', '#ff2b26'] : ['主动装备', '#8cde21']) : ['启用装备', '#999'];
  rows.push(`<div class="r st"><i></i><b style="color:${col}">${txt}</b></div>`);
  return rows.join('');
}
// 按装备编号跟踪悬停：装备栏会重画（换掉按钮元素），不绑元素
const modEl = (i) => root?.querySelector(`.pl-mod[data-pl-mod="${i}"]`);
function showTip(i) {
  const b = modEl(i);
  if (!S.hud.tips || !b || S.rk?.drag || root.querySelector('.pl-cmenu, .pl-umenu')) { hideTip(); return; }
  const stage = root.querySelector('#plStage');
  let el = root.querySelector('.pl-mtip');
  if (!el) { el = document.createElement('div'); el.className = 'pl-mtip'; el.innerHTML = '<div class="b"></div><i class="ptr"></i>'; stage.appendChild(el); }
  el.querySelector('.b').innerHTML = modTipHtml(i);
  S.tip = { i };
  // 在装备上方居中，指针朝下
  const st = stage.getBoundingClientRect(), r = b.getBoundingClientRect();
  const x = Math.max(4, Math.min(st.width - el.offsetWidth - 4, r.left - st.left + r.width / 2 - el.offsetWidth / 2));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(r.top - st.top - el.offsetHeight - 6)}px`;
  el.querySelector('.ptr').style.left = `${Math.round(r.left - st.left + r.width / 2 - x - 12)}px`;
}
let tipTimer = 0;
function hideTip() {
  clearTimeout(tipTimer);
  S.tip = null;
  root?.querySelector('.pl-mtip')?.remove();
}
function refreshTip() { if (S.tip) showTip(S.tip.i); }
function onRackHover(e) {
  const b = e.target.closest?.('.pl-mod');
  if (!b || !S.hud.tips) return;
  const i = Number(b.dataset.plMod);
  if (S.hov === i) return;
  S.hov = i;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { if (S.hov === i) showTip(i); }, S.tip ? 0 : 200);
}
function onRackOut(e) {
  if (!e.target.closest?.('.pl-mod') || e.relatedTarget?.closest?.('.pl-mod')) return;
  S.hov = null;
  hideTip();
}

// ---------- 装备右键菜单（客户端 ModuleButton.GetMenu）----------
// 能装弹药的：可换的弹药（客户端列的是货舱里有的，模拟里没有货舱：列出全部能装的市场弹药）、重新加载、装填所有；
// 能超载的：开启 / 关闭超载、超载整级槽位、关闭超载整级槽位；编组的：清空装备组
function ammoChoices(i) {
  const t = ctx.data.types.get(S.on.rack[i].type);
  if (!t || !ctx.FE.AT.chargeGroups.some((a) => t.attrs.get(a))) return [];
  return [...ctx.data.types.values()].filter((c) => c.category === ctx.FE.CAT.charge && c.market && ctx.FE.chargeFits(t, c)).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
}
function openModMenu(i, e) {
  hideTip();
  closeMenus();
  // 客户端 ShipModuleButton.GetMenu 的顺序，再经 clientMenu 按组排：
  //   自动装填 / 自动循环 / 超载三项不在组表里（排最前）→ 弹药与装填（ACTIONSGROUP）→ 清空装备组（DESTRUCTIVEGROUP，橙色感叹号）
  //   超载开关带图标（开 circle_plus、关 pause）；装上线 / 下线、修理、显示信息模拟里没有
  const items = [];
  const m = masterOf(i), cur = chargeOf(m);
  const ammo = ammoChoices(m);
  for (const c of ammo) if (c.id !== cur) items.push([typeName(c.id), () => setAmmo(m, c.id), { g: 1 }]);
  if (cur) items.push([`重新加载 (${typeName(cur)})`, () => reloadMods(members(m)), { g: 1 }]);
  if (ammo.length) items.push(['装填所有', () => reloadMods(S.on.guns.map((g) => g.m).filter((x) => x != null)), { g: 1 }]);
  if (cur || R.ammoState?.(m)) items.push(S.noReload?.has(m) ? ['启用自动装载', () => R.setAutoReload(m, true)] : ['停止自动装填', () => R.setAutoReload(m, false)]);
  if (R.canRepeat?.(m)) items.push(S.repeatOff?.has(m) ? ['启用自动循环', () => R.setRepeat(m, true)] : ['停止自动循环', () => R.setRepeat(m, false)]);
  if (canOverload(m) && !S.hud.lockOvl && !S.rk.burnt.has(m)) {
    const on = S.rk.ovl.has(m), r = S.on.rack[m].slot;
    items.push([on ? '关闭超载' : '开启超载', () => toggleOverload(m), { ic: `${UI}eveicon/system_icons/${on ? 'pause' : 'circle_plus'}_16px.png?v=1` }]);
    items.push(['超载整级槽位', () => setRackOverload(r, true)]);
    items.push(['关闭超载整级槽位', () => setRackOverload(r, false)]);
  }
  if (S.rk.grp.get(m)?.length) items.push(['清空装备组', () => ungroup(m), { g: 17, warn: true }]);
  if (!items.length) return;
  S.cm = clientMenu(items);
  cmenuAt(e);
}
// 菜单项：[文字, 函数] / [文字, [子菜单项…]]（▸，悬停展开）/ [文字, 函数, { on: 勾选状态, off: 灰掉 }]；null = 分隔线
// k：路径「2」「2.1」…
function menuItem(k) { let list = S.cm, it = null; for (const i of String(k).split('.').map(Number)) { it = list?.[i]; list = Array.isArray(it?.[1]) ? it[1] : null; } return it; }
function runMenu(k) {
  const it = menuItem(k);
  if (!it || it[2]?.off || it[2]?.lbl) return;
  const f = Array.isArray(it[1]) ? it[2]?.fn : it[1];
  if (!f) return;
  closeMenus();
  f?.();
}
const setRackOverload = (r, on) => R.setRackOverload(r, on);
function ungroup(m) {
  const sl = S.rk.grp.get(m) || [];
  S.rk.grp.delete(m);
  placeFreed(sl);
  rackSave();
  renderRack();
}
// 舰船模式切换（冷却中、已经是这个模式就不动）
function setMode(k) {
  if (R.setMode(k)) updStance();
}
// 换弹药：整组一起换，换上就开始装填（重新装填时间），装填期间不开火
function setAmmo(m, type) {
  R.setAmmo(m, type);
  renderRack();
}
const reloadMods = (list, quiet) => R.reloadMods(list, quiet);

// ---------- 装备栏：照客户端 slotsContainer / shipmodulebutton ----------
// 每格 64×64（slotMainCombined 底座，48×48 的装备按钮居中），横向间距 51、纵向 44；
// 三排的起点 (1, 0) / (1.5, 1) / (1, 2) 格，第 i 个在 left = (起点 + i) × 51 − 40
const SLOT_GRID = [[1, 0], [1.5, 1], [1, 2]];
const RACKS = ['high', 'mid', 'low'];
const RK_KEY = 'eve-pilot-rack';
// 整排超载按钮（客户端 overloadBtn）：在装备栏容器里 (13,52) / (20,66) / (13,80)，20×20
const RK_OV_POS = [[13, 52], [20, 66], [13, 80]];
const RK_OV_TEX = ['hi', 'med', 'lo'];
const { isGun, sameKind, masterOf, members, canOverload } = R;
// 装备在装备栏里的位置（可能被拖到了别的排）
const posOf = (i) => { for (const r of RACKS) { const n = S.rk.order[r].indexOf(i); if (n >= 0) return [r, n]; } return null; };
// 整排超载按的是装备真实所在的槽位排（服务器 OverloadRack），不管它在装备栏里摆在哪一排
const rackMods = (r) => RACKS.flatMap((x) => S.rk.order[x]).filter((i) => i >= 0 && S.on.rack[i].slot === r);
function rackInit() {
  const rack = S.on.rack || [];
  const key = `${flyShip()}:${S.tut ? 'tut' : S.set.fit}:${rack.map((m) => `${m.type}/${m.charge}`).join(',')}`;
  const order = {};
  RACKS.forEach((r) => {
    const o = Array(8).fill(-1);
    rack.map((m, i) => [m, i]).filter(([m]) => m.slot === r).forEach(([, i], n) => { if (n < 8) o[n] = i; });
    order[r] = o;
  });
  let saved = null;
  try { saved = (ctx.store.getJSON(RK_KEY, {}) || {})[key] || null; } catch { /* 用默认 */ }
  // 存的排布要和现在的装配对得上（整个装备栏同一批装备；客户端的排序表是 24 格一张，装备可以跨排摆）才用
  const flat = (o) => JSON.stringify(RACKS.flatMap((r) => o[r].slice(0, 8)).filter((x) => x >= 0).sort((a, b) => a - b));
  const grp = new Map((S.match ? [] : saved?.grp || []).filter(([m, sl]) => isGun(m) && sl.every((x) => isGun(x) && sameKind(m, x))));
  const freed = new Set([...grp.values()].flat());
  if (saved?.order && RACKS.every((r) => Array.isArray(saved.order[r]) && saved.order[r].length >= 8)
      && flat(saved.order) === JSON.stringify(RACKS.flatMap((r) => order[r]).filter((x) => x >= 0 && !freed.has(x)).sort((a, b) => a - b))) {
    for (const r of RACKS) order[r] = saved.order[r].slice(0, 8);
  } else grp.clear();
  // 热量、超载、烧毁等规则状态：pilot-rules
  R.rackInit(grp);
  Object.assign(S.rk, { key, order, drag: null });
}
function rackSave() {
  let all = {};
  try { all = ctx.store.getJSON(RK_KEY, {}) || {}; } catch { /* 新建 */ }
  all[S.rk.key] = { order: S.rk.order, grp: S.match ? all[S.rk.key]?.grp || [] : [...S.rk.grp] };
  ctx.store.setJSON(RK_KEY, all);
  if (S.match) R.syncGroupState();
}
function renderRack() {
  const box = root.querySelector('#plRack');
  if (!box || !S.rk) return;
  const rack = S.on.rack || [];
  const tog = toggleable();
  const key = (r, n) => (r === 'high' ? `F${n}` : r === 'mid' ? `Alt+F${n}` : `Ctrl+F${n}`);
  let html = '';
  RACKS.forEach((r, ri) => {
    const [gx, gy] = SLOT_GRID[ri];
    S.rk.order[r].forEach((i, n) => {
      const pos = `left:${Math.round((gx + n) * 51 - 40)}px;top:${gy * 44}px`;
      const kind = i >= 0 ? (tog.has(i) ? 'tog' : 'passive') : '';
      // 空槽（显示空槽位时：这一排船上有的槽位画空槽图标，透明 0.25）；被动装备不显示时那格空着
      if (i < 0 || masterOf(i) !== i || (kind === 'passive' && !S.hud.passive)) {
        const empty = i < 0 && S.hud.empty && n < slotCount(r);
        html += `<div class="pl-slot${empty ? ' empty' : ''}" data-pl-slot="${r}:${n}" style="${pos}"${empty ? ` title="${EMPTY_SLOT[ri]}"` : ''}>${empty ? `<img src="${UI}icons/${EMPTY_ICON[ri]}.png?v=1" alt="">` : ''}</div>`;
        return;
      }
      const m = rack[i];
      const cnt = members(i).length;
      const tip = `${typeName(m.type)}${cnt > 1 ? ` ×${cnt}` : ''}${chargeOf(i) ? ' · ' + typeName(chargeOf(i)) : ''}${kind === 'tog' ? ` (${key(r, n + 1)})` : unsupported(i) ? ' · 驾驶模拟里暂不支持' : ' · 被动'}${canOverload(i) ? ' · Shift + 点击超载' : ''}${m.off ? ' · ' + m.off : ''}`;
      // 装了弹药时按钮显示弹药的图标（和游戏一样）
      const icon = IMG(chargeOf(i) || m.type, 'icon', 64);
      html += `<button type="button" class="pl-mod ${kind}" data-pl-mod="${i}" data-pl-slot="${r}:${n}" draggable="${S.hud.lockMods ? 'false' : 'true'}" style="${pos}"${S.hud.tips ? '' : ` title="${esc(tip)}"`} aria-label="${esc(tip)}">
        <span class="pl-ramp"><b><i></i></b><b><i></i></b></span><u class="pl-dmg"></u>
        <i class="pl-mod-ovl${canOverload(i) ? ' can' : ''}" ${canOverload(i) ? `data-pl-ovl="${i}" title="超载（Shift + 点击装备）"` : ''}></i>
        <img src="${icon}" alt="" loading="lazy" draggable="false">${chargeOf(i) ? '<em><span></span></em>' : ''}${cnt > 1 ? `<s>${cnt}</s>` : ''}</button>`;
    });
  });
  // 整排超载（这一排有能超载的装备才显示）
  RACKS.forEach((r, ri) => {
    if (!rackMods(r).some((i) => canOverload(i))) return;
    html += `<button type="button" class="pl-rkov" data-pl-rkov="${r}" style="left:${RK_OV_POS[ri][0]}px;top:${RK_OV_POS[ri][1]}px" title="超载整排"></button>`;
  });
  // 全部编组 / 取消编组（有两件以上同型号武器才显示）
  if (groupableSets().some((s) => s.length > 1)) html += '<button type="button" class="pl-grpall" data-pl-grpall></button>';
  box.innerHTML = html;
  updateRack();
}
// 能编到一组的：同型号、同弹药的武器
function groupableSets() {
  const by = new Map();
  for (const g of S.on.guns) { if (g.m == null || S.rk.burnt.has(g.m)) continue; const k = `${S.on.rack[g.m].type}/${S.on.rack[g.m].charge}`; if (!by.has(k)) by.set(k, []); by.get(k).push(g.m); }
  return [...by.values()];
}
const canGroupAll = () => groupableSets().some((s) => s.length > 1 && new Set(s.map(masterOf)).size > 1);
function placeFreed(list) {
  for (const x of list) {
    if (posOf(x)) continue;
    // 先放回自己那一排的空格，满了就放别排
    const r0 = S.on.rack[x].slot;
    for (const r of [r0, ...RACKS.filter((y) => y !== r0)]) { const o = S.rk.order[r], n = o.indexOf(-1); if (n >= 0) { o[n] = x; break; } }
  }
}
function groupAll() {
  if (canGroupAll()) {
    for (const s of groupableSets()) {
      if (s.length < 2) continue;
      // 主武器取这组里排得最靠前的
      const at = (x) => { const p = posOf(x); return p ? RACKS.indexOf(p[0]) * 8 + p[1] : 99; };
      const sorted = s.slice().sort((a, b) => at(a) - at(b));
      for (const m of s) S.rk.grp.delete(m);
      S.rk.grp.set(sorted[0], sorted.slice(1));
      for (const x of sorted.slice(1)) { const p = posOf(x); if (p) S.rk.order[p[0]][p[1]] = -1; }
    }
    syncGroupState();
  } else {
    const slaves = [...S.rk.grp.values()].flat();
    S.rk.grp.clear();
    placeFreed(slaves);
  }
  rackSave();
  renderRack();
}
// 编组后组里每件的开关、超载状态跟主武器一致
const syncGroupState = () => R.syncGroupState();
const toggleOverload = (i) => R.toggleOverload(i);
const toggleRackOverload = (r) => R.toggleRackOverload(r);
// 拖动（客户端 SwapSlots / ChangeSlots）：装备栏 24 格任意两格互换，可以跨排；拖到同型号武器上编成一组（按住 Shift 只换位置）；
// Shift 把组里的一件拖到空格 = 拆出来。拖着走的只有装备（装了弹药就是弹药）图标
function onRackDragStart(e) {
  const b = e.target.closest?.('.pl-mod');
  if (!b || !S.rk) return;
  if (S.hud.lockMods) { e.preventDefault(); return; }   // 锁定装备位置
  hideTip();
  const i = Number(b.dataset.plMod);
  S.rk.drag = { i, r: S.on.rack[i].slot };
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* 部分浏览器 */ }
  const box = root.querySelector('#plRack');
  box.classList.add('dragging');
  // 拖动图只取图标本身；原位变淡要等浏览器截完拖动图再加，不然拖着走的也是淡的
  const img = b.querySelector('img');
  if (img && e.dataTransfer.setDragImage) { const r = img.getBoundingClientRect(); e.dataTransfer.setDragImage(img, r.width / 2, r.height / 2); }
  setTimeout(() => { if (S.rk?.drag?.i === i) b.classList.add('drag-src'); }, 0);
  for (const x of box.querySelectorAll('.pl-mod')) {
    const j = Number(x.dataset.plMod);
    x.classList.toggle('ghl', j !== i && isGun(i) && isGun(j) && sameKind(i, j));
  }
}
function onRackDragEnd() {
  const box = root.querySelector('#plRack');
  if (!box) return;
  box.classList.remove('dragging');
  for (const x of box.querySelectorAll('.ghl, .drag-src')) x.classList.remove('ghl', 'drag-src');
  if (S.rk) S.rk.drag = null;
}
function onRackDragOver(e) {
  const d = S.rk?.drag;
  const t = e.target.closest?.('[data-pl-slot]');
  if (!d || !t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function onRackDrop(e) {
  const d = S.rk?.drag;
  const t = e.target.closest?.('[data-pl-slot]');
  if (!d || !t) return;
  const [r, nStr] = t.dataset.plSlot.split(':'), n = Number(nStr);
  e.preventDefault();
  const o = S.rk.order[r], from = posOf(masterOf(d.i));
  const j = t.classList.contains('pl-mod') ? Number(t.dataset.plMod) : -1;
  if (j >= 0 && j !== masterOf(d.i) && isGun(d.i) && isGun(j) && sameKind(d.i, j) && !e.shiftKey) {
    // 编组：拖过去的那组并到目标那组，目标是主武器
    const add = members(d.i);
    for (const x of add) S.rk.grp.delete(x);
    S.rk.grp.set(j, [...(S.rk.grp.get(j) || []), ...add]);
    for (const x of add) { const p = posOf(x); if (p) S.rk.order[p[0]][p[1]] = -1; }
    syncGroupState();
  } else if (j < 0 && e.shiftKey && (S.rk.grp.get(masterOf(d.i)) || []).length) {
    // 拆组：组里最后一件放到这个空格
    const m = masterOf(d.i), sl = S.rk.grp.get(m), x = sl.pop();
    if (!sl.length) S.rk.grp.delete(m);
    o[n] = x;
  } else if (from && (from[0] !== r || from[1] !== n)) {
    const fo = S.rk.order[from[0]];
    [fo[from[1]], o[n]] = [o[n], fo[from[1]]];
  }
  onRackDragEnd();
  rackSave();
  renderRack();
}
function updateRack() {
  const box = root.querySelector('#plRack'), u = S.me;
  if (!box || !u || !S.rk) return;
  // 用画面时间（比引擎慢不到一步、逐帧连续）算进度，圈是平滑转的
  const t = Math.min(S.t, S.b.t), P = u.pilot, rk = S.rk;
  for (const b of box.querySelectorAll('.pl-mod')) {
    const i = Number(b.dataset.plMod);
    const on = P.on.has(i) || (b.classList.contains('auto') && u.alive);
    const deact = rk.deact.get(i);
    const busy = Boolean(deact && deact.end > t && u.alive);
    // 周期进度：武器按下次开火时间，其它按开启时刻
    const gk = u.t.guns.findIndex((g) => g.m === i);
    let p = 0, rld = false, rp = 0;
    if (gk >= 0) {
      const st = u.guns[gk], g = u.t.guns[gk];
      rld = st.reloadUntil > t;
      if (rld) rp = 1 - (st.reloadUntil - t) / g.reload;
      else if (P.on.has(i) && t - st.last < g.cycle * 1.3 + DT) {
        // 引擎已经算到下一发（画面还没到）：画面上还是上一轮在走
        const cyc = Math.max(0.1, st.next - st.last);
        const base = t >= st.last ? st.last : st.last - cyc;
        p = Math.max(0, Math.min(1, (t - base) / cyc));
      }
      const em = b.querySelector('em span');
      if (em) em.textContent = g.ammo < Infinity ? (rld ? '' : st.ammo) : '';
    } else {
      // 电容注入器、辅助维修：有弹药数和装填
      // 电容注入器、辅助维修、拦截泡发射器：有弹药数和装填
      const ik = (u.t.injectors || []).findIndex((x) => x.m === i), lk = ik < 0 ? (u.t.localReps || []).findIndex((x) => x.m === i && x.ammo < Infinity) : -1;
      const dk = ik < 0 && lk < 0 ? (u.t.dictors || []).findIndex((x) => x.m === i) : -1;
      const x = ik >= 0 ? u.t.injectors[ik] : lk >= 0 ? u.t.localReps[lk] : dk >= 0 ? u.t.dictors[dk] : null;
      const st = ik >= 0 ? u.inj[ik] : lk >= 0 ? u.lrep[lk] : dk >= 0 ? u.dict?.[dk] || { ammo: x.ammo, reloadUntil: 0, next: 0 } : null;
      if (x) {
        rld = st.reloadUntil > t;
        if (rld) rp = 1 - (st.reloadUntil - t) / x.reload;
        const em = b.querySelector('em span');
        if (em) em.textContent = rld ? '' : st.ammo;
      }
      if (!rld && P.on.has(i)) {
        // 没有持续时间的装备（隐形装置：效果没有 durationAttributeID）只有开 / 关两态，不画周期圈（客户端 DoActivateRampsThread：duration ≤ 0 直接返回）
        const cyc = x?.cycle || S.on.rack[i]?.cycle || 0;
        if (x && st.next > 0) p = Math.max(0, Math.min(1, 1 - (st.next - t) / cyc));
        else if (cyc > 0) { const t0 = S.modOn.get(i) ?? t; p = (((t - t0) % cyc) + cyc) % cyc / cyc; }
      }
    }
    // 停用中：红光闪到这一轮结束，圈接着走完
    if (busy) p = Math.max(0, Math.min(1, (t - deact.t0) / deact.cyc));
    const burnt = rk.burnt.has(i);
    b.classList.toggle('on', on && u.alive && !busy && !burnt);
    b.classList.toggle('busy', busy);
    b.classList.toggle('wait', rk.wait.has(i));
    b.classList.toggle('rld', rld);
    b.classList.toggle('burnt', burnt);
    b.classList.toggle('ovl', rk.ovl.has(i));
    // 装填：圈从满倒着退（先退右半圈）
    const v = rld ? 1 - rp : p;
    b.classList.toggle('cyc', ((on || busy) && u.alive && p > 0) || rld);
    // 周期指示：左半圈先转（0→50%），右半圈后转（50%→100%），每半圈转角 π(1 − 进度)
    const up = Math.min(1, Math.max(0, v * 2)), down = Math.min(1, Math.max(0, v * 2 - 1));
    b.style.setProperty('--rl', `${-180 * (1 - up)}deg`);
    b.style.setProperty('--rr', `${-180 * (1 - down)}deg`);
    // 热损：slotDamage_1..8
    const hp = members(i).reduce((a, x) => Math.max(a, (rk.dmg.get(x) || 0) / (rk.heat[x]?.hp || 40)), 0);
    const dmgEl = b.querySelector('.pl-dmg'), di = hp > 0.0001 ? Math.max(1, Math.min(8, Math.floor(hp * 8))) : 0;
    if (dmgEl && dmgEl.dataset.n !== String(di)) { dmgEl.dataset.n = di; dmgEl.style.backgroundImage = di ? `url(${UI}classes/shipui/slotdamage_${di}.png?v=1)` : ''; }
  }
  for (const b of box.querySelectorAll('[data-pl-rkov]')) {
    const list = rackMods(b.dataset.plRkov).filter((i) => canOverload(i) && !rk.burnt.has(i));
    b.classList.toggle('on', list.length > 0 && list.every((i) => rk.ovl.has(i)));
  }
  const ga = box.querySelector('[data-pl-grpall]');
  if (ga) { const g = canGroupAll(); ga.classList.toggle('un', !g); ga.title = g ? '全部编组同型号武器' : '取消全部编组'; }
}
// 每步模拟之后：等目标的装备在有了当前目标时启动；超载的装备产生热量、按周期受热损，耐久打完就烧毁

// ---------- 锁定的目标：客户端 targetMgr —— 锚在「选中物体」窗口左边 15 像素、顶上 16，新锁上的从右往左排，一个 110 宽 ----------
function drawTargets() {
  const box = root.querySelector('#plTargets'), u = S.me;
  if (!box || !u) return;
  const P = u.pilot;
  // 锁定进度只在太空里的框上转，锁好了才进目标栏
  const list = [...P.locks.keys()].filter((v) => !(P.locks.get(v) > 0));
  // 被打掉的目标（客户端 TargetInBar.anim_death）：血条清空，随机等 0–0.2 秒，红盘（target_killed，红色透明 0.2，0.1 秒出现）
  // + 骷髅（加色混合），整个目标 BlinkIn（透明 0→1 线性，0.2 秒一次 × 6），然后图标纵向 0.04 秒压扁消失；
  // 动画就在它原来的位置播，播完才从目标栏拿掉（后面的目标这时才挪过来）
  S.tgtDead = S.tgtDead || new Map();
  for (const v of S.tgtShown || []) if (!list.includes(v) && !v.alive && !S.tgtDead.has(v)) S.tgtDead.set(v, performance.now() + Math.random() * 200);
  for (const [v, t0] of S.tgtDead) if (performance.now() - t0 > 1240) S.tgtDead.delete(v);
  S.lockOrder = (S.lockOrder || []).filter((v) => list.includes(v) || S.tgtDead.has(v));
  for (const v of list) if (!S.lockOrder.includes(v)) S.lockOrder.push(v);
  const shown = S.lockOrder.slice();
  S.tgtShown = shown;
  const sel = root.querySelector('[data-win="sel"]'), stage = root.querySelector('#plStage');
  if (sel && stage && !sel.hidden && sel.offsetWidth) {
    const sr = stage.getBoundingClientRect(), wr = sel.getBoundingClientRect();
    const right = Math.max(0, sr.right - wr.left + 15);
    box.style.right = right + 'px';
    box.style.maxWidth = Math.max(110, sr.width - right - 60) + 'px';
  } else { box.style.right = '420px'; box.style.maxWidth = ''; }
  const ids = shown.map((v) => v.i).join(',');
  if (box.dataset.ids !== ids) {
    box.dataset.ids = ids;
    box.innerHTML = shown.map((v) => `<button type="button" class="pl-tgt" data-pl-tgt="${v.i}"><canvas width="200" height="200"></canvas>
      <span class="pl-tgt-l"><b>${esc(S.names[v.i])}</b><span>${esc(typeName(v.r.row.ship))}</span><small></small></span><span class="pl-tgt-w"></span></button>`).join('');
  }
  [...box.children].forEach((el, n) => {
    const v = shown[n], dead = S.tgtDead.get(v);
    drawTarget(el.querySelector('canvas'), v, v === P.active, dead);
    const de = dead != null ? performance.now() - dead : -1;
    el.style.opacity = de >= 0 && de < 1200 ? String((de % 200) / 200) : '';
    el.style.pointerEvents = dead != null ? 'none' : '';
    const d = el.querySelector('small'), dt = fmtDist(surf(u, v));
    if (d.textContent !== dt) d.textContent = dt;
    el.classList.toggle('is-active', v === P.active);
    // 作用在这个目标上的装备（开着的武器、电子战，同组的算一个）+ 在打它的无人机
    const mods = v === P.active && u.alive ? [...P.on].filter((m) => !S.selfMods.has(m) && masterOf(m) === m && !(u.t.localReps || []).some((x) => x.m === m) && !(u.t.injectors || []).some((x) => x.m === m)) : [];
    const dr = u.drones?.some((x) => x.pos && x.target === v);
    const key = mods.join(',') + (dr ? 'd' : '');
    const w = el.querySelector('.pl-tgt-w');
    if (w.dataset.k !== key) {
      w.dataset.k = key;
      const sz = mods.length + (dr ? 1 : 0) <= 2 ? 32 : 24;
      w.style.setProperty('--sz', sz + 'px');
      w.innerHTML = mods.map((m) => `<img src="${IMG(S.on.rack[m].type, 'icon', 64)}" alt="" title="${esc(typeName(S.on.rack[m].type))}">`).join('') + (dr ? `<img src="${UI}icons/56_64_5.png?v=1" alt="" title="无人机">` : '');
    }
  });
}
// 贴图按颜色染（客户端 Sprite.color 相乘：白图 × 颜色）
const tintCache = new Map();
function tintedTex(path, color) {
  const k = path + color;
  if (tintCache.has(k)) return tintCache.get(k);
  const im = tex(path);
  if (!ready(im)) return null;
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(im, 0, 0);
  tintCache.set(k, c);
  return c;
}
const icons = new Map();
function shipIcon(id) {
  if (!icons.has(id)) { const im = new Image(); im.src = IMG(id, 'icon', 64); icons.set(id, im); }
  return icons.get(id);
}
function drawTarget(c, v, isActive, dead) {
  const x = c.getContext('2d');
  x.setTransform(2, 0, 0, 2, 0, 0);
  x.clearRect(0, 0, 100, 100);
  const cx = 50, cy = 50, now = performance.now();
  const de = dead != null ? now - dead : null;
  // 当前目标：四角（白 0.2）逆时针 3.5 秒一圈、0.2↔0.5 呼吸，外加 selectedTargetedItem
  if (isActive) {
    const sp = tex('classes/target/spincorners.png');
    if (ready(sp)) { x.save(); x.translate(cx, cy); x.rotate(-now / 3500 * Math.PI * 2); x.globalAlpha = 0.35 + 0.15 * Math.sin(now / 3000 * Math.PI * 2); x.drawImage(sp, -60, -60, 120, 120); x.restore(); }
    const s = tex('classes/target/selectedtargeteditem.png');
    if (ready(s)) { x.globalAlpha = 0.15; x.drawImage(s, cx - 40, cy - 40, 80, 80); x.globalAlpha = 1; }
  }
  const oc = tex('classes/target/outercircle.png');
  if (ready(oc)) { x.globalAlpha = isActive ? 0.5 : 0.25; x.drawImage(oc, cx - 48, cy - 48, 96, 96); x.globalAlpha = 1; }
  const bg = tex('classes/target/targetbackground.png');
  if (ready(bg)) x.drawImage(bg, cx - 47, cy - 47, 94, 94);
  // 图标容器（舰船图标、红盘、骷髅）：死亡动画最后纵向压扁
  const sy = de != null && de > 1200 ? Math.max(0, 1 - (de - 1200) / 40) : 1;
  x.save(); x.translate(cx, cy); x.scale(1, sy); x.translate(-cx, -cy);
  const ic = shipIcon(v.r.row.ship);
  if (ready(ic)) { x.save(); x.beginPath(); x.arc(cx, cy, 25, 0, Math.PI * 2); x.clip(); x.globalAlpha = isActive ? 1 : 0.8; x.drawImage(ic, cx - 25, cy - 25, 50, 50); x.restore(); }
  if (de != null && de >= 0) {
    const disc = tintedTex('icons/target_killed.png', '#ff0000'), sk = tex('icons/target_killed_skull.png');
    if (disc) { x.globalAlpha = 0.2 * Math.min(1, de / 100); x.drawImage(disc, cx - 47, cy - 47, 94, 94); x.globalAlpha = 1; }
    if (ready(sk)) { x.globalCompositeOperation = 'lighter'; x.drawImage(sk, cx - 32, cy - 32, 64, 64); x.globalCompositeOperation = 'source-over'; }
  }
  x.restore();
  // 三层血弧：左右两半各 135°（一共 270°，缺口在下面），贴图自带颜色；从右半圈的末端往回扣
  const A0 = 135 * Math.PI / 180, SPAN = 270 * Math.PI / 180;
  const hpA = tgtHp(v, [0, 1, 2].map((l) => (v.t.max[l] ? Math.max(0, Math.min(1, v.hp[l] / v.t.max[l])) : 0)));
  ['shield', 'armor', 'hull'].forEach((n, l) => {
    const f = dead != null || !v.t.max[l] ? 0 : hpA[l];
    for (const side of ['left', 'right']) {
      const im = tex(`classes/target/${n}${side}.png`);
      if (!ready(im)) continue;
      x.globalAlpha = 0.2; x.drawImage(im, cx - 47, cy - 47, 94, 94); x.globalAlpha = 1;
      if (f <= 0) continue;
      x.save(); x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, 60, A0, A0 + SPAN * f); x.closePath(); x.clip();
      x.drawImage(im, cx - 47, cy - 47, 94, 94);
      x.restore();
    }
  });
}

// ---------- 太空中的标记：锁定框、当前目标、选中 ----------
// ---------- 指定空间点航行（客户端 tacticalNavigation/controlPaths.SinglePointPath）----------
// 第一步：在过本舰的水平面上取点（鼠标射线和水平面求交；射线朝上 / 下够不到平面时取反方向最远处），点一下定下；
// 第二步：在过本舰、包含水平方向和竖直方向的竖直平面上取高度，距离保持第一步的距离（点落在以本舰为心的球面上），再点一下出发
const MV_COLOR = [0, 173, 238];          // navUI.COLOR_MOVE (0, 0.678, 0.933)
const MV_MAX = 4000000;                  // _MAX_PICK_DISTANCE
const v3 = { add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  len: (a) => Math.hypot(a[0], a[1], a[2]), norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
function mvStart() {
  if (!S.me?.alive || !S.view?.rayAt || S.mv) return;
  S.mv = { state: 'xz', xz: null, dest: null };
}
function mvAbort() { S.mv = null; }
function mvAddPoint() {
  const m = S.mv;
  if (!m) return;
  mvUpdate();
  if (m.state === 'xz') { if (m.xz) m.state = 'y'; return; }
  if (!m.dest) return;
  // 客户端 GoToPoint + IndicateMoveCommand：落点标记和一条移动连线，3 秒后消失
  cmd({ cmd: 'point', pt: m.dest.slice(), tgt: null });
  S.mvPending = { pt: m.dest.slice(), t0: performance.now() };
  S.mv = null;
}
function mvUpdate() {
  const m = S.mv;
  if (!m || !S.mxy) return;
  const c = S.view.drawnPos(S.me.i);
  const r = S.view.rayAt(S.mxy[0], S.mxy[1]);
  if (!c || !r) return;
  m.c = c;
  if (m.state === 'xz') {
    if (r.d[1] === 0) return;
    const k = (r.o[1] - c[1]) / -r.d[1];
    let pos = v3.add(r.o, v3.mul(r.d, k)), dir = v3.sub(pos, c);
    if (k < 0) { dir = v3.norm(v3.mul(dir, -1)); pos = v3.add(c, v3.mul(dir, MV_MAX)); }
    if (v3.len(dir) > MV_MAX) pos = v3.add(c, v3.mul(v3.norm(dir), MV_MAX));
    m.xz = pos; m.dest = pos;
  } else {
    const xd = v3.sub(m.xz, c), L = v3.len(xd), n = v3.cross(v3.norm(xd), [0, 1, 0]);
    const den = v3.dot(r.d, n);
    if (Math.abs(den) < 1e-9) return;
    const t = v3.dot(v3.sub(c, r.o), n) / den;
    const hit = v3.add(r.o, v3.mul(r.d, t));
    const dir = v3.mul(v3.norm(v3.sub(hit, c)), t < 0 ? -1 : 1);
    m.dest = v3.add(c, v3.mul(dir, L));
  }
}
// 线型（navUI.GetConnectorStyle）：STRONG 宽 2、透明 0.5；FAINT 宽 1.5、0.1；DOTTED 宽 2、黑 0.5 底 + 实色点
function mvLine(x, pts, style) {
  const P = pts.map((p) => S.view.project(p));
  if (P.some((p) => !p)) return;
  const col = (a) => `rgba(${MV_COLOR.join(',')},${a})`;
  const path = () => { x.beginPath(); P.forEach((p, n) => (n ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); };
  if (style === 'dotted') {
    path(); x.setLineDash([]); x.lineWidth = 2; x.strokeStyle = 'rgba(0,0,0,0.5)'; x.stroke();
    path(); x.setLineDash([2, 4]); x.strokeStyle = col(1); x.stroke(); x.setLineDash([]);
  } else { path(); x.lineWidth = style === 'faint' ? 1.5 : 2; x.strokeStyle = col(style === 'faint' ? 0.1 : style === 'medium' ? 0.3 : 0.5); x.stroke(); }
}
function drawMove(x) {
  if (S.mv && !S.me.alive) S.mv = null;
  const m = S.mv;
  if (m) {
    mvUpdate();
    if (m.c && m.dest) {
      const c = m.c, d = m.dest, xz = m.xz, R = v3.len(v3.sub(d, c));
      // 距离圈（RANGE_SPHERE，STRONG）：以本舰为心、过落点的水平圆
      const ring = [];
      for (let a = 0; a <= 96; a++) { const t = a / 96 * Math.PI * 2; ring.push([c[0] + Math.cos(t) * R, c[1], c[2] + Math.sin(t) * R]); }
      mvLine(x, ring, 'strong');
      mvLine(x, [c, xz], 'dotted');                       // 水平方向（DOTTED）
      if (m.state === 'y') {
        mvLine(x, [xz, d], 'faint');                     // 竖直线（FAINT）
        const arc = [];                                  // 球面弧（DOTTED）：水平点 → 落点
        const a0 = v3.norm(v3.sub(xz, c)), a1 = v3.norm(v3.sub(d, c));
        const om = Math.acos(Math.max(-1, Math.min(1, v3.dot(a0, a1))));
        for (let k = 0; k <= 32; k++) {
          const f = k / 32, s0 = om > 1e-4 ? Math.sin((1 - f) * om) / Math.sin(om) : 1 - f, s1 = om > 1e-4 ? Math.sin(f * om) / Math.sin(om) : f;
          arc.push(v3.add(c, v3.mul(v3.add(v3.mul(a0, s0), v3.mul(a1, s1)), R)));
        }
        mvLine(x, arc, 'dotted');
      }
      mvLine(x, [c, d], 'strong');                        // 航线（STRONG）
      // 距离（千米，取整），中点，实色，字号 20
      const mid = S.view.project(v3.mul(v3.add(c, d), 0.5));
      if (mid) {
        x.font = '20px "EVE Sans Neue", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillStyle = `rgb(${MV_COLOR.join(',')})`; x.fillText(String(Math.max(0, Math.round(R / 1000))), mid[0], mid[1]);
      }
    }
  }
  const pd = S.mvPending;
  if (pd) {
    if (performance.now() - pd.t0 > 3000 || S.me.pilot.cmd !== 'point') { S.mvPending = null; return; }
    const c = S.view.drawnPos(S.me.i);
    if (c) mvLine(x, [c, pd.pt], 'medium');               // 移动连线（COLOR_MOVE，0.3）
    const p = S.view.project(pd.pt), sc = tex('classes/bracket/selectioncircle.png');
    if (p && ready(sc)) x.drawImage(sc, p[0] - 8, p[1] - 8, 16, 16);
  }
}
function drawMarks() {
  const c = root.querySelector('#plMarks'), u = S.me;
  if (!c || !u || !S.view) return;
  const w = c.clientWidth, h = c.clientHeight, k = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * k) || c.height !== Math.round(h * k)) { c.width = Math.round(w * k); c.height = Math.round(h * k); }
  const x = c.getContext('2d');
  x.setTransform(k, 0, 0, k, 0, 0);
  x.clearRect(0, 0, w, h);
  const P = u.pilot;
  // 战术视图距离圈上的千米数（白 0.5）
  if (S.set.tac && S.view.tacLabels) {
    x.font = '10px "EVE Sans Neue", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = 'rgba(255,255,255,0.5)';
    for (const [lx, ly, r] of S.view.tacLabels()) x.fillText(String(r), lx, ly);
  }
  drawMove(x);
  const frame = tint('classes/bracket/shiptarget.png', '#ff5040'), arrow = tint('classes/bracket/activetarget.png', '#ffffff'), selc = tex('classes/bracket/selectioncircle.png');
  for (const [v, left] of P.locks) {
    const s = S.view.screenOf(v.i);
    if (!s) continue;
    if (left > 0) {
      // 锁定中（客户端 bracket）：倒计时弧（timerLeft/Right 76 像素，0.4）+ 四角转着收紧
      const lag = Math.max(0, S.b.t - Math.min(S.t, S.b.t));
      const prog = Math.max(0, Math.min(0.999, 1 - (left + lag) / (P.lockAll.get(v) || 1)));
      const tl = tex('classes/target/timerleft.png'), trr = tex('classes/target/timerright.png');
      if (ready(tl) && ready(trr)) {
        x.save(); x.globalAlpha = 0.4; x.beginPath(); x.moveTo(s[0], s[1]); x.arc(s[0], s[1], 50, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); x.closePath(); x.clip();
        x.drawImage(tl, s[0] - 38, s[1] - 38, 76, 76); x.drawImage(trr, s[0] - 38, s[1] - 38, 76, 76); x.restore();
      }
      const sp = tex('classes/target/spincorners.png'), g = 1.6 - 0.9 * prog;
      if (ready(sp)) { x.save(); x.translate(s[0], s[1]); x.rotate(performance.now() / 600); x.drawImage(sp, -30 * g, -30 * g, 60 * g, 60 * g); x.restore(); }
    } else if (frame) x.drawImage(frame, s[0] - 17, s[1] - 17, 34, 34);
    if (v === P.active && arrow) x.drawImage(arrow, s[0] - 22, s[1] - 9, 44, 18);
  }
  if (S.sel >= 0 && S.sel !== 0 && ready(selc)) { const s = S.view.screenOf(S.sel); if (s) x.drawImage(selc, s[0] - 15, s[1] - 15, 30, 30); }
}

// ---------- 总览 ----------
// 分页和颜色照游戏里的默认总览；每页按游戏默认总览配置（assets/eveui/overview-default.json，
// 由 tools/ui-assets/overview.py 从客户端的 old_default 数据生成）里对应预设的物品组过滤
// 页签名和颜色照游戏截图（玩家常用的那套总览，颜色按截图取色，没选中的也不压暗）；标题里的预设名是客户端 old_default 预设的本地化名（overview/default/const.py preset_name_ids）
const OV_TABS = [['通用', 'default', '#00cc99'], ['采矿', 'defaultmining', '#ff6600'], ['跃迁到', 'defaultwarpto', '#3399ff'], ['刷怪', 'defaultall', '#ff0000'], ['PVP', 'defaultpvp', '#ffff00'], ['可拾取', 'defaultloot', '#66ff00'], ['打捞', 'defaultdrones', '#668b8b'], ['天体/行星海关', 'defaultwarpto', '#cd950c']];
const OV_PRESET = { default: '通用', defaultmining: '采矿', defaultwarpto: '跃迁到', defaultall: '全部', defaultpvp: 'PVP', defaultloot: '拾取', defaultdrones: '无人机' };
const OV_KEY = 'eve-pilot-ovtab';
let ovPresets = null, ovLoad = null;
const loadOvPresets = () => (ovLoad ||= fetch(`${UI}overview-default.json?v=1`).then((r) => (r.ok ? r.json() : null)).then((d) => {
  ovPresets = d ? Object.fromEntries(Object.entries(d.presets).map(([k, v]) => [k, new Set(v)])) : {};
  renderOverview();
}).catch(() => { ovPresets = {}; }));
// UI/Tactical/OverviewCaption：「总览 ({preset})」
const ovTitle = () => `${tr('总览')} (${tr(OV_PRESET[OV_TABS[S.ovTab ?? 0][1]])})`;
function setOvTab(i) {
  S.ovTab = i;
  ctx.store.setJSON(OV_KEY, i);
  for (const b of root.querySelectorAll('[data-pl-ovtab]')) b.classList.toggle('on', Number(b.dataset.plOvtab) === i);
  ovLine();
  const t = root.querySelector('#plOvTitle');
  if (t) t.textContent = ovTitle();
  const body = root.querySelector('#plOv');
  if (body) body.textContent = '';
  applyOvCols();
  renderOverview();
}
// 页签下的选中线（客户端 TabGroup：1px，激活窗口 #58A7BF、否则 #B0B0B0，0.05 ~ 0.15 秒滑过去）
function ovLine() {
  const bar = root?.querySelector('.pl-ov-tabs'), on = bar?.querySelector('button.on'), ln = bar?.querySelector('.pl-ov-line');
  if (!on || !ln) return;
  // 标签间距 24，排不下时往 12 收
  bar.style.gap = '24px';
  const n = bar.querySelectorAll('button').length;
  if (bar.scrollWidth > bar.clientWidth && n > 1) bar.style.gap = `${Math.max(12, 24 - Math.ceil((bar.scrollWidth - bar.clientWidth) / (n - 1)))}px`;
  ln.style.left = `${on.offsetLeft}px`;
  ln.style.width = `${on.offsetWidth}px`;
}
// 同一网格（引擎 GRID，约 8000 km，船心距离）：总览和太空里的图标只显示这个范围内的船
const onGrid = (v) => !S.me || v === S.me || Math.hypot(v.pos[0] - S.me.pos[0], v.pos[1] - S.me.pos[1], v.pos[2] - S.me.pos[2]) <= GRID;
const ovPvp = () => OV_TABS[S.ovTab ?? 0][1] === 'defaultpvp';
// 这一页显示不显示某个类型（配置还没加载完时全显示）
const ovShows = (type) => ovShowsGroup(ctx.data.types.get(type)?.group);
const ovShowsGroup = (g) => {
  const set = ovPresets?.[OV_TABS[S.ovTab ?? 0][1]];
  return !set || set.has(g);
};
const surf = (u, v) => Math.max(0, Math.hypot(v.pos[0] - u.pos[0], v.pos[1] - u.pos[1], v.pos[2] - u.pos[2]) - u.t.radius - (v.t?.radius || 0));
const AU = 149597870700;
// 游戏的距离写法：1 万米以内按米，往上按整公里，再远按天文单位
const fmtDist = (m) => (m < 10000 ? `${Math.round(m).toLocaleString('en-US')} m` : m < 0.1 * AU ? `${Math.round(m / 1000).toLocaleString('en-US')} km` : `${(m / AU).toFixed(1)} AU`);
// 原地更新每一行（不整表重画，点击不会落空）；顺序变了才重新排
function renderOverview() {
  const body = root.querySelector('#plOv'), u = S.me;
  if (!body || !u) return;
  if (!ovPresets) loadOvPresets();
  const P = u.pilot;
  // 舰船：只列同一网格里的（客户端只知道自己周围的球，别的网格上的船要扫描才找得到）；天体按页签的物品组过滤（「跃迁到」等）
  // PVP 页签：只列敌方舰船——天体、空间站、友军、无人机都不列（按用户的游戏内 PVP 页签）
  const pvp = ovPvp();
  const list = S.b.units.filter((v) => v !== u && v.alive && !v.warp && onGrid(v) && (!pvp || v.side !== u.side) && ovShows(v.r.row.ship)).map((v) => ({ k: 'u' + v.i, v, d: surf(u, v) }));
  if (!pvp) (S.b.cel || []).forEach((c, i) => { if (ovShowsGroup(c.group) && !ST.celHidden(c) && (!c.site || celDist(u, c) <= GRID)) list.push({ k: 'c' + i, c, ci: i, d: celDist(u, c) }); });
  // 太空中的无人机（敌我都有）也列出来，只看不点
  for (const o of S.b.units) {
    if (!o.alive || pvp) continue;
    o.drones.forEach((dr, n) => { if (dr.pos && !dr.e && ovShows(dr.g.type) && Math.hypot(dr.pos[0] - u.pos[0], dr.pos[1] - u.pos[1], dr.pos[2] - u.pos[2]) <= GRID) list.push({ k: `d${o.i}-${n}`, dr, o, d: surf(u, { pos: dr.pos }) }); });
  }
  list.sort((a, b) => a.d - b.d);
  // 什么都没有：一行「没有发现任何东西」（UI/Common/NothingFound）
  if (!list.length) {
    if (body.firstElementChild?.dataset.k !== 'none') body.innerHTML = `<tr class="none" data-k="none"><td colspan="5">${esc(tr('没有发现任何东西'))}</td></tr>`;
    return;
  }
  body.querySelector('tr.none')?.remove();
  const rows = new Map([...body.children].map((tr) => [tr.dataset.k, tr]));
  const keep = new Set(list.map((x) => x.k));
  for (const [k, tr] of rows) if (!keep.has(k)) { tr.remove(); rows.delete(k); }
  list.forEach((x, n) => {
    let tr = rows.get(x.k);
    const v = x.v;
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.k = x.k;
      if (v) {
        tr.dataset.plOv = v.i;
        // 图标格（客户端 SpaceObjectIcon）：16×16 舰船类别图标 + 角上 10×10 状态旗 + 锁定 / 被锁的框
        tr.innerHTML = `<td><span class="pl-ovi"><img src="${typeIcon(v.r.row.ship, S.brk[v.i] || 'frigate')}" alt=""><i class="tg"></i><i class="hb"></i><i class="lk"></i><b class="fl"></b></span></td><td></td><td>${esc(S.names[v.i])}</td><td>${esc(typeName(v.r.row.ship))}</td><td><span class="sp"></span><span class="pl-ovew"></span></td>`;
      } else if (x.c) {
        tr.dataset.plOvc = x.ci;
        tr.className = 'cel';
        tr.innerHTML = `<td><span class="pl-ovi"><img src="${celIcon(x.c)}" alt=""></span></td><td></td><td>${esc(x.c.name)}</td><td>${esc(x.c.typeName || '')}</td><td><span class="sp"></span></td>`;
      } else {
        tr.className = `drone ${x.o.side !== u.side ? 'hostile' : 'friend'}`;
        tr.innerHTML = `<td><span class="pl-ovi"><img src="${typeIcon(x.dr.g.type, 'dronelightscout')}" alt=""></span></td><td></td><td>${esc(typeName(x.dr.g.type))}</td><td>${esc(typeName(x.dr.g.type))}</td><td><span class="sp"></span></td>`;
      }
    }
    if (v) {
      const lk = P.locks.has(v) ? (P.locks.get(v) > 0 ? 'locking' : 'locked') : '';
      // 锁定我：u.target 是我 —— 还在锁 = 黄框闪（hostileBracket），锁上了在打 = 红框闪
      // 对面是玩家（匹配对战）：看他的锁定表
      const pl = v.pilot?.locks.get(u);
      const onMe = v.pilot ? (pl == null ? '' : pl > 0 ? ' aggr' : ' atk') : v.target === u ? (v.lock > 0 ? ' aggr' : ' atk') : '';
      tr.className = `${v.side !== u.side ? 'hostile' : 'friend'}${v.i === S.sel ? ' sel' : ''}${lk ? ' ' + lk : ''}${v === P.active ? ' act' : ''}${onMe}`;
      const img = tr.cells[0].querySelector('img'), src = typeIcon(v.r.row.ship, S.brk[v.i] || 'frigate');
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      // 对我用着的电子战 / 遥修：行右侧 16px 图标（客户端 UpdateEwar，TORIGHT）
      // 舰队广播（锁定 / 维修目标 / 需要维修…）：最前面放一个广播图标
      const ew = [...(S.ewar || new Map())].filter(([, e]) => e.from.has(v)).map(([k]) => k).join(',');
      const bk = FL.markOf(v);
      const box = tr.cells[4].lastChild;
      if (box.dataset.ew !== ew + '|' + (bk || '')) {
        box.dataset.ew = ew + '|' + (bk || '');
        box.innerHTML = (bk ? `<img src="${FL.markIcon(bk)}" alt="" title="${esc(bcHint(bk))}">` : '') + (ew ? ew.split(',').map((k) => `<img src="${buffIcon(k)}" alt="" title="${esc(buffHint(k))}">`).join('') : '');
      }
    }
    if (x.c) tr.classList.toggle('sel', x.ci === S.selC);
    tr.cells[1].textContent = fmtDist(x.d);
    tr.cells[4].firstChild.textContent = x.c ? '0' : Math.round(Math.hypot(...(v ? v.vel : x.dr.vel))).toLocaleString('en-US');
    if (body.children[n] !== tr) body.insertBefore(tr, body.children[n] || null);
  });
}

// ---------- 选中的物体窗口（客户端 selectedItemWnd）----------
// 按钮行：接近、跃迁至，然后常显的几项。常显项（ACTIONS_ALWAYS_VISIBLE）反编译后原文丢了，只知道是 6 项；
// 这里按客户端带快捷键的通用动作取了环绕、保持距离、锁定目标、观察、跟踪（显示信息模拟里没有，没放）
// 当前不可用就换成反向动作（锁定目标 → 解除目标锁定、观察 → 重置视角），反向动作的按钮上叠一张 44_32_8
const CI = (n, px = 32) => `<img src="${UI}eveicon/control_icons/${n}_${px}px.png?v=1" alt="">`;
const SEL_ACTS = [
  { k: 'approach', n: '接近', ic: 'approach', key: 'Q' },
  { k: 'warp', n: '跃迁至', ic: 'warp_to', key: 'S', off: '你所处的距离不适合跃迁' },
  { k: 'orbit', n: '环绕', ic: 'orbit', key: 'W', dflt: 'orbit' },
  { k: 'keep', n: '保持距离', ic: 'keep_at_distance', key: 'E', dflt: 'keep' },
  { k: 'lock', n: '锁定目标', ic: 'target', key: 'Ctrl', rev: { k: 'unlock', n: '解除目标锁定', key: 'Ctrl + Shift' } },
  { k: 'look', n: '观察', ic: 'look_at', key: 'Alt', rev: { k: 'look0', n: '重置视角', key: '' } },
  { k: 'track', n: '跟踪', ic: 'camera_track', key: 'C' }
];
function selActs(v) {
  const P = S.me.pilot;
  if (v?.cel != null) {
    const near = celDist(S.me, S.b.cel[v.cel]) < 150000;
    // 客户端对天体也列出整排按钮（不能用的变灰）；这里环绕、保持距离、锁定、观察、跟踪对天体还没做
    const acts = SEL_ACTS.map((a) => ({ ...a, off: a.k === 'approach' ? '' : a.k === 'warp' ? (near ? a.off : '') : '驾驶模拟里对天体暂不支持' }));
    // 加速轨道 / 深渊导管（客户端 selectedItemConst：groupWarpGate → UI/Inflight/ActivateGate，图标 jump_to，排在接近、跃迁至之后）
    const gk = ST.gateOf(v.cel)?.kind;
    if (gk === 'gate' || gk === 'conduit') acts.splice(2, 0, { k: 'gate', n: '激活加速轨道', ic: 'jump_to', key: 'D' });
    // 残骸（selectedItemConst：groupWreck → UI/Commands/OpenCargo，图标 open_cargo）
    if (ST.wreckOf(v.cel)) acts.splice(2, 0, { k: 'loot', n: '打开货柜', ic: 'open_cargo', key: '' });
    return acts;
  }
  return SEL_ACTS.map((a) => {
    if (a.k === 'warp') a = { ...a, off: surf(S.me, v) < 150000 ? a.off : '' };
    const rev = a.rev && ((a.k === 'lock' && P.locks.has(v)) || (a.k === 'look' && S.view?.following?.() === v.i));
    const tracking = a.k === 'track' && S.view?.tracking?.() === v.i;
    return { ...a, ...(rev ? a.rev : {}), ic: tracking ? 'camera_untrack' : a.ic, rev, tracking };
  });
}
function renderSel(soft = false) {
  const box = root.querySelector('#plSel'), u = S.me;
  if (!box || !u) return;
  const v = S.b.units[S.sel];
  // 选中天体
  const c = S.selC >= 0 ? S.b.cel?.[S.selC] : null;
  if (c) {
    const d = celDist(u, c), acts = selActs({ cel: S.selC });
    const key = `c${S.selC}:${acts.map((a) => a.k + (a.off ? 'x' : '')).join(',')}`;
    if (soft && box.dataset.k === key) { box.querySelector('.pl-sel-dist').textContent = fmtDist(d); return; }
    box.dataset.k = key;
    box.innerHTML = `<div class="pl-sel-top"><img src="${IMG(c.type, 'icon', 64)}" alt="" onerror="this.onerror=null;this.className='cel';this.src='${celIcon(c)}'"><div class="pl-sel-txt"><b>${esc(c.name)}</b><span class="pl-sel-dist">${fmtDist(d)}</span></div></div>
      <div class="pl-sel-acts">${acts.map((a) => `<button type="button" data-pl-act="${a.k}"${a.off ? ' aria-disabled="true"' : ''} data-pl-hint="${a.k}">${CI(a.ic)}</button>`).join('')}</div>`;
    return;
  }
  // 没选东西：左上一行大字「没有选择物体」（EveCaptionMedium 20px，白 0.5），按钮行清空
  if (!v || v === u || !v.alive) {
    if (box.dataset.k !== 'none') { box.dataset.k = 'none'; box.innerHTML = `<div class="pl-sel-empty">${esc(tr('没有选择物体'))}</div>`; }
    return;
  }
  const d = surf(u, v), acts = selActs(v);
  const key = `${v.i}:${acts.map((a) => a.k + (a.tracking ? 't' : '') + (a.off ? 'x' : '')).join(',')}`;
  if (soft && box.dataset.k === key) { box.querySelector('.pl-sel-dist').textContent = fmtDist(d); return; }
  box.dataset.k = key;
  // 名字：有人开的船写角色名，没人开的写类型名（uix.GetSlimItemName）；距离行只有数字（到表面的距离）
  box.innerHTML = `<div class="pl-sel-top"><img src="${IMG(v.r.row.ship, 'render', 64)}" alt=""><div class="pl-sel-txt"><b>${esc(S.names[v.i])}</b><span class="pl-sel-dist">${fmtDist(d)}</span></div></div>
    <div class="pl-sel-acts">${acts.map((a) => `<button type="button" data-pl-act="${a.k}"${a.off ? ' aria-disabled="true"' : ''} data-pl-hint="${a.k}">${CI(a.ic)}${a.rev ? `<img class="rev" src="${UI}icons/44_32_8.png?v=1" alt="">` : ''}</button>`).join('')}</div>`;
}
// 按钮悬停提示（两列：动作名 + 快捷键，不可用时下面再一行原因；指针朝上）
function hintHtml(k) {
  const v = S.selC >= 0 ? { cel: S.selC } : S.b?.units[S.sel];
  const a = v && selActs(v).find((x) => x.k === k);
  if (!a) return '';
  return `<div class="r head"><span>${esc(tr(a.tracking ? '停止跟踪' : a.n))}</span>${a.key ? `<kbd>${esc(a.key)}</kbd>` : ''}</div>${a.off ? `<div class="r why">${esc(tr(a.off))}</div>` : ''}`;
}
function showHint(el) {
  const html = hintHtml(el.dataset.plHint);
  if (!html) return;
  const stage = root.querySelector('#plStage');
  let tip = root.querySelector('.pl-htip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'pl-mtip pl-htip'; tip.innerHTML = '<div class="b"></div><i class="ptr"></i>'; stage.appendChild(tip); }
  tip.querySelector('.b').innerHTML = html;
  const st = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  const x = Math.max(4, Math.min(st.width - tip.offsetWidth - 4, r.left - st.left + r.width / 2 - tip.offsetWidth / 2));
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(r.bottom - st.top + 8)}px`;
  tip.querySelector('.ptr').style.left = `${Math.round(r.left - st.left + r.width / 2 - x - 12)}px`;
}
const hideHint = () => root?.querySelector('.pl-htip')?.remove();
function onHintOver(e) { const el = e.target.closest?.('[data-pl-hint]'); if (el) showHint(el); }
function onHintOut(e) { const el = e.target.closest?.('[data-pl-hint]'); if (el && !el.contains(e.relatedTarget)) hideHint(); }
// 右键「环绕 / 保持距离」按钮：一项「设置默认…距离」，点了弹数量框（uix.QtyPopup，米，环绕 500 ~ 1,000,000、保持距离 50 ~ 1,000,000）
function onSelCtx(e) {
  const b = e.target.closest?.('.pl-sel-acts [data-pl-act]');
  if (!b) return;
  e.preventDefault();
  const a = SEL_ACTS.find((x) => x.k === b.dataset.plAct);
  if (!a?.dflt && a?.k !== 'warp') return;
  hideHint();
  closeMenus();
  if (a.k === 'warp') { warpMenu(e, b.getAttribute('aria-disabled') === 'true'); return; }
  S.cm = [[a.dflt === 'orbit' ? '设置默认“环绕”距离' : '设置默认的“保持距离”', () => qtyPopup(a.dflt)]];
  cmenuAt(e);
}
// 跃迁按钮右键（客户端 menusvc 的「跃迁至」子菜单）：「{distance}内」0 ~ 100 km，再加「设置默认距离」
function warpMenu(e, off) {
  const tgt = S.selC >= 0 ? { cel: S.selC } : S.b?.units[S.sel];
  const km = (d) => (d ? `${d / 1000} km` : '0 m');
  const cur = warpD();
  S.cm = [
    ...(off ? [] : WARP_DISTS.map((d) => [`跃迁至 ${km(d)}内${d === cur ? '（默认）' : ''}`, () => tgt && warpTo(tgt, d)])),
    ['设置默认距离', () => { S.cm = WARP_DISTS.map((d) => [`${km(d)}内${d === cur ? ' ✓' : ''}`, () => ctx.store.setJSON(WARPD_KEY, d)]); cmenuAt(e); }],
    ...(off || !tgt ? [] : FL.warpItems(tgt, tgt.cel == null && FL.isFleetMember(tgt)))
  ];
  cmenuAt(e);
}
// 右键总览里的船：锁定、接近、环绕、保持距离，远处的可以跃迁；有舰队时加广播、关注列表（客户端 menusvc 里的同名条目）
// 「跃迁至」子菜单（menusvc.WarpToMenu）：七个距离 + 设置默认距离；点「跃迁至」本身按默认距离跃迁
function warpSub(fn) {
  const cur = warpD(), km = (d) => (d ? `${d / 1000} km` : '0 m');
  return [...WARP_DISTS.map((d) => [`${km(d)}内`, () => fn(d)]), null, ['设置默认距离', WARP_DISTS.map((d) => [km(d), () => ctx.store.setJSON(WARPD_KEY, d), { on: d === cur }])]];
}
// 朝向该处（客户端 AlignTo）：船头转向目标方向
function alignTo(tgt) {
  const p = tgt?.cel != null ? S.b?.cel[tgt.cel]?.pos : tgt?.pos, u = S.me;
  if (!p || !u?.alive) return;
  const off = p.map((x, k) => x - u.pos[k]), l = Math.hypot(...off) || 1;
  if (R.cmd({ cmd: 'dir', dir: off.map((x) => x / l), tgt: null })) pushLog(`正在朝向${tgt.cel != null ? S.b.cel[tgt.cel].name : S.names[tgt.i]}`, 'sys');
}
// bare：舰队窗口成员行用，只要舰船操作（舰队条目另给）
function unitMenu(v, bare = false) {
  const items = [], P = S.me?.pilot;
  if (!P || !v) return items;
  if (v !== S.me && v.alive) {
    // 跃迁（menusvc._CelestialMenu）：150 km 外才有；舰队成员的船用「跃迁至该成员」那套带领跃迁文字
    if (surf(S.me, v) >= 150000 && !v.warp) {
      items.push(['跃迁至', warpSub((d) => warpTo(v, d)), { fn: () => warpTo(v) }]);
      if (!bare) items.push(...FL.warpItems(v, FL.isFleetMember(v)));
    }
    items.push(['接近', () => cmd({ cmd: 'approach', tgt: v })], ['环绕', () => cmd({ cmd: 'orbit', tgt: v, dist: S.orbit })], ['保持距离', () => cmd({ cmd: 'keep', tgt: v, dist: S.keep })]);
    if (surf(S.me, v) >= 150000) items.push(['朝向该处', () => alignTo(v)]);
    // 观察 / 设为镜头关注（跟踪）、锁定：_CelestialMenu 里排在移动指令后面（同属 ACTIONSGROUP）
    if (!bare) {
      items.push(S.view?.following?.() === v.i ? ['重置视角', () => act('look0', v)] : ['观察', () => act('look', v)]);
      if (S.view?.tracking?.() !== v.i) items.push(['跟踪', () => act('track', v)]);
    }
    items.push(P.locks.has(v) ? ['解除目标锁定', () => act('unlock', v)] : ['锁定目标', () => lockUnit(v)]);
  }
  if (bare) return items;
  items.push(...FL.fleetMenu(v));
  return clientMenu(items);
}
// 右键天体（menusvc._CelestialMenu 的顺序）：跃迁至 ▸、带领跃迁、接近、朝向该处、广播：跃迁到 / 朝向该处
function celMenu(i) {
  const c = S.b?.cel[i], u = S.me, items = [];
  if (!c || !u?.pilot) return items;
  items.push(...ST.gateItems(i));
  const far = celDist(u, c) >= 150000;
  if (far) items.push(['跃迁至', warpSub((d) => warpTo({ cel: i }, d)), { fn: () => warpTo({ cel: i }) }], ...FL.warpItems({ cel: i }));
  else items.push(['接近', () => celApproach(i)]);
  items.push(['朝向该处', () => alignTo({ cel: i })]);
  if (S.fleet) items.push([FL.bcName('warp'), () => FL.broadcast('warp', { cel: i })], [FL.bcName('align'), () => FL.broadcast('align', { cel: i })]);
  return clientMenu(items);
}
function onStageCtx(e) {
  if (S.fleet && FL.fleetCtx(e)) return;
  if (SC.scanCtx(e)) return;
  const ct = e.target.closest?.('#plOv tr[data-pl-ovc]');
  if (ct) { e.preventDefault(); hideHint(); closeMenus(); S.cm = celMenu(Number(ct.dataset.plOvc)); if (S.cm.length) cmenuAt(e); return; }
  const tr0 = e.target.closest?.('#plOv tr[data-pl-ov]');
  if (!tr0) return;
  const v = S.b?.units[Number(tr0.dataset.plOv)];
  if (!v) return;
  e.preventDefault();
  hideHint();
  closeMenus();
  S.cm = unitMenu(v);
  if (S.cm.length) cmenuAt(e);
}
// 右键自己的船（客户端 menusvc._CelestialMenu 里对自己船给的条目，按原顺序）：停止舰船、重置视角
function selfMenu(e) {
  hideHint();
  closeMenus();
  S.cm = clientMenu([['停止舰船', () => cmd({ cmd: 'stop', tgt: null })], ['重置视角', () => S.view?.follow(S.me?.i ?? 0)]]);
  cmenuAt(e);
}
// 太空物体右键菜单照客户端排（carbonui menuDataFactory.CreateMenuDataWithEntries，组和图标见 menuUtil / actionConst）：
//   每项按所属组在 menuHierarchy 里的位置稳定排序，不在组表里的（舰队广播、邀请加入舰队等）算 −1 排最前；
//   相邻两项组不同就画分隔线，手写的分隔线（None）也一起排到最前，等于不起作用。
//   图标：ICON_BY_ACTIONID 里有的动作画 16px 图标（观察、重置视角在黑名单里不画），广播条目带广播图标。
const CM_GROUP = { 跃迁至: 1, 接近: 1, 环绕: 1, 保持距离: 1, 朝向该处: 1, 观察: 1, 跟踪: 1, 重置视角: 1, 停止舰船: 1, 锁定目标: 1, 解除目标锁定: 1, 激活加速轨道: 1, 舰队: 7 };
const CM_ICON = { 跃迁至: 'warp_to', 接近: 'approach', 环绕: 'orbit', 保持距离: 'keep_at_distance', 朝向该处: 'align_to', 锁定目标: 'target', 解除目标锁定: 'target', 激活加速轨道: 'jump_to', 打开货柜: 'open_cargo' };
const cmGroup = (t) => CM_GROUP[t] ?? (t.startsWith('带领') ? 4 : -1);   // 带领舰队跃迁…：FLEETGROUP
// 条目第三项可带 { g: 组在 menuHierarchy 里的序号, ic: 图标, warn: DESTRUCTIVEGROUP 的橙色感叹号组图标 }
function clientMenu(items) {
  const list = items.filter(Boolean).map((it, n) => ({ it, n, g: it[2]?.g ?? cmGroup(it[0]) })).sort((a, b) => a.g - b.g || a.n - b.n);
  const out = [];
  list.forEach(({ it, g }, k) => {
    if (k && g !== list[k - 1].g) out.push(null);
    const ic = it[2]?.ic || (CM_ICON[it[0]] ? `${UI}eveicon/control_icons/${CM_ICON[it[0]]}_16px.png?v=1` : FL.bcIconOf(it[0]));
    out.push(ic ? [it[0], it[1], { ...(it[2] || {}), ic }] : it);
  });
  return out;
}
function cmenuAt(e) {
  for (const m of root?.querySelectorAll('.pl-cmenu') || []) m.remove();
  const stage = root.querySelector('#plStage'), st = stage.getBoundingClientRect();
  cmenuBuild(S.cm, '', e.clientX - st.left, e.clientY - st.top - 8, 0);
}
function cmenuBuild(list, path, x, y, depth, anchorW = 0) {
  const stage = root.querySelector('#plStage'), st = stage.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'pl-cmenu';
  el.dataset.depth = depth;
  // 有一项带图标，整列文字都给图标让位（MenuData.GetIconSize：任一项有图标就 16）
  const icons = list.some((it) => it?.[2]?.ic || it?.[2]?.warn);
  el.classList.toggle('ic', icons);
  el.innerHTML = list.map((it, i) => {
    if (!it) return i === 0 || !list[i - 1] || !list.slice(i + 1).some(Boolean) ? '' : '<hr>';   // 连续 / 开头 / 结尾的分隔线不画
    const k = path ? `${path}.${i}` : `${i}`, sub = Array.isArray(it[1]), o = it[2] || {};
    if (o.lbl) return `<div class="lbl">${esc(tr(it[0]))}</div>`;
    const chk = o.on != null ? `<img class="ck" src="${UI}classes/utilmenu/checkbox${o.on ? 'active' : 'inactive'}.png?v=1" alt="">` : o.radio != null ? `<img class="ck" src="${UI}classes/utilmenu/radiobutton${o.radio ? 'active' : 'inactive'}.png?v=1" alt="">` : '';
    // 组图标（MenuEntryView.ConstructGroupIcon）：底圆按组色，上面叠白色符号
    const mi = !icons ? '' : o.warn ? `<em class="mi gi warn"><img src="${UI}classes/menu/exclamationmark.png?v=1" alt=""></em>` : o.ic ? `<img class="mi" src="${o.ic}" alt="">` : '<em class="mi"></em>';
    return `<button type="button" class="${sub ? 'sub' : ''}${o.off ? ' off' : ''}" data-pl-cm="${k}">${mi}${chk}<span>${esc(tr(it[0]))}</span>${sub ? `<img class="ar" src="${UI}icons/1_16_14.png?v=1" alt="">` : ''}</button>`;
  }).join('');
  stage.appendChild(el);
  if (x + el.offsetWidth > st.width) x -= el.offsetWidth + 2 + anchorW;
  el.style.left = `${Math.round(Math.max(0, x))}px`;
  el.style.top = `${Math.round(Math.max(0, Math.min(st.height - el.offsetHeight, y)))}px`;
  // 悬停有子菜单的项：在右边展开（同级的其他子菜单收起）
  el.addEventListener('pointerover', (ev) => {
    const b = ev.target.closest('button[data-pl-cm]');
    if (!b) return;
    for (const m of root.querySelectorAll('.pl-cmenu')) if (Number(m.dataset.depth) > depth && m.dataset.from !== b.dataset.plCm) m.remove();
    if (!b.classList.contains('sub') || root.querySelector(`.pl-cmenu[data-from="${b.dataset.plCm}"]`)) return;
    const r = b.getBoundingClientRect();
    const c = cmenuBuild(menuItem(b.dataset.plCm)[1], b.dataset.plCm, r.right - st.left + 2, r.top - st.top - 8, depth + 1, r.width + 4);
    c.dataset.from = b.dataset.plCm;
  });
  return el;
}
function qtyPopup(which) {
  const [lo, hi] = which === 'orbit' ? [500, 1000000] : [50, 1000000];
  const cur = Math.round(which === 'orbit' ? S.orbit : S.keep);
  const stage = root.querySelector('#plStage');
  root.querySelector('.pl-qty')?.remove();
  const el = document.createElement('div');
  el.className = 'pl-qty';
  const hint = which === 'orbit' ? `将“环绕”的默认距离设为${lo.toLocaleString('en-US')}米与${hi.toLocaleString('en-US')}米之间。` : `将“保持距离”的默认距离设为${lo.toLocaleString('en-US')}米与${hi.toLocaleString('en-US')}米之间。`;
  el.innerHTML = `<div class="pl-qty-h">${esc(tr(which === 'orbit' ? '环绕' : '保持距离'))}</div><p>${esc(tr(hint))}</p><input type="number" min="${lo}" max="${hi}" step="1" value="${cur}" data-pl-qtyv><div class="pl-qty-b"><button type="button" class="pl-btn" data-pl-qty="${which}">${esc(tr('确定'))}</button><button type="button" class="pl-btn" data-pl-qty="">${esc(tr('取消'))}</button></div>`;
  stage.appendChild(el);
  const inp = el.querySelector('input');
  inp.focus();
  inp.select();
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') qtyDone(which); if (e.key === 'Escape') qtyDone(''); });
}
function qtyDone(which) {
  const el = root.querySelector('.pl-qty');
  if (!el) return;
  if (which) {
    const [lo, hi] = which === 'orbit' ? [500, 1000000] : [50, 1000000];
    const n = Number(el.querySelector('input').value);
    if (Number.isFinite(n)) { const m = Math.max(lo, Math.min(hi, Math.round(n))); if (which === 'orbit') S.orbit = m; else S.keep = m; }
  }
  el.remove();
}

// ---------- 伤害信息（照游戏：画面中间偏上浮出，新的一行在最下面，旧的往上推，几秒后淡出）----------
// 同一时刻同一组武器打同一个目标合成一行（几发中几发、取最好的命中质量）；排队每秒最多出 6 行，排了 5 秒还没出的丢掉
const DMG_TYPES = ['electromagnetic', 'thermal', 'kinetic', 'explosive'];
const TYPE_ORDER = [0, 3, 2, 1];   // 图标顺序：电磁、爆炸、动能、热能
// 客户端本地化 UI/Inflight/HitQuality1..6
const Q_NAMES = ['完全没有打中', '轻轻擦过', '擦过', '命中', '穿透', '强力一击', '致命一击'];
// 炮台伤害倍数 → 命中质量档位（下标对应 Q_NAMES）
const qualityOf = (m) => (!m ? 0 : m >= 3 ? 6 : m >= 1.25 ? 5 : m >= 1 ? 4 : m >= 0.75 ? 3 : m >= 0.62 ? 2 : 1);
// 参数照游戏客户端 CombatMessage：每秒最多 6 行、排队超过 5 秒丢掉、透明度 5 秒内 0→1（0.2 处）→0，
// 旧行上推 0.4 秒（最近 8 秒消息多于 8 条时 0.166 秒），推到第 5 格的行用 1/6 秒淡出；同一个攻击者的“没打中”10 秒内只报一次
const MSG = { life: 5000, lineH: 20, max: 6, gap: 1000 / 6, move: 400, peak: 0.2, busyMove: 166, busyPeak: 0.05, missQuiet: 10000 };
const M = { pend: new Map(), queue: [], lines: [], lastOut: 0, recent: [], quiet: new Map() };
function resetMsgs() {
  M.pend.clear(); M.queue.length = 0; M.lines.length = 0; M.recent.length = 0; M.quiet.clear();
  const box = root?.querySelector('#plDmsg');
  if (box) box.textContent = '';
}
// 引擎的逐发回调：只记跟自己有关的（自己 / 自己的无人机打出去的，打到自己身上的）
function logHit(h) {
  const me = S.me;
  if (!me || (h.f !== me && h.v !== me)) return;
  const out = h.f === me, other = out ? h.v : h.f;
  const key = `${out ? 'o' : 'i'}${other.i}:${h.type}`;
  let e = M.pend.get(key);
  if (!e) M.pend.set(key, e = { dir: out ? 'out' : 'in', src: other.i, name: S.names[other.i] || '', weapon: typeName(h.type), dmg: 0, hits: 0, shots: 0, q: 0, raw: [0, 0, 0, 0], missile: true, drone: Boolean(h.drone) });
  e.shots++;
  e.missile = e.missile && Boolean(h.missile);
  if (h.mult) { e.hits++; e.dmg += h.dmg; e.q = Math.max(e.q, qualityOf(h.mult)); h.raw.forEach((x, k) => { e.raw[k] += x; }); }
}
// 中和 / 吸电（客户端 OnEnergyNeutAttacker / Defender、OnEnergyNosAttacker / Defender，属于战斗消息里的「电容战」一类）：
// 屏幕上和伤害一样飘一行，日志窗口也记一条。这几条消息的原文不在客户端本地化数据里（服务器下发），文字是照英文客户端的格式写的
function logDrain(h) {
  const me = S.me;
  if (!me || (h.f !== me && h.v !== me) || (h.nos && !(h.amt > 0.5))) return;
  const out = h.f === me, other = out ? h.v : h.f;
  const mod = typeName(h.f.t.rack?.[h.m]?.type);
  const amt = Math.round(h.amt);
  const what = h.nos ? (out ? `+${amt} GJ 能量吸取自` : `-${amt} GJ 能量被吸取至`) : `${amt} GJ 能量被中和`;
  M.queue.push({ at: performance.now(), e: { html: `<b class="${out ? 'out' : 'in'}">${esc(what)}</b> <strong>${esc(S.names[other.i] || '')}</strong><span>${esc(` - ${mod}`)}</span>` } });
  pushLog(`${what} ${S.names[other.i] || ''} - ${mod}`, out ? 'good' : 'neg');
}
// 每步模拟结束：把这一步合好的行放进队列
function flushHits() {
  const now = performance.now();
  for (const e of M.pend.values()) {
    // 打到自己身上的“没打中”：同一个攻击者 10 秒内只报一次；打中了就重新计
    if (e.dir === 'in') {
      if (!e.hits) { if (now - (M.quiet.get(e.src) ?? -Infinity) < MSG.missQuiet) continue; M.quiet.set(e.src, now); } else M.quiet.delete(e.src);
    }
    M.queue.push({ at: now, e });
  }
  M.pend.clear();
}
function msgHtml(e) {
  if (e.html) return e.html;
  const n = (x) => esc(x);
  // 没打中是整句（AttackMiss / AttackMissBanked / AttackMissR / AttackMissRD）
  if (!e.hits) return `<i>${n(e.dir === 'out' ? (e.shots > 1 ? `你的一组${e.weapon}完全没有打中${e.name}` : `你的${e.weapon}完全没有打中${e.name}`) : e.drone ? `${e.name}的${e.weapon}完全没有击中你` : `${e.name}完全没有打中你`)}</i>`;
  const icons = TYPE_ORDER.filter((k) => e.raw[k] > 0).map((k) => `<img src="${UI}classes/damagetypes/${DMG_TYPES[k]}.png?v=1" alt="">`).join('');
  return `<b class="${e.dir}">${Math.round(e.dmg)}</b> ${icons ? `<em>${icons}</em> ` : ''}<small>${e.dir === 'out' ? '对' : '来自'}</small> <strong>${n(e.name)}</strong><span>${n(` - ${e.weapon}${e.missile ? '' : ` - ${Q_NAMES[e.q]}`}`)}</span>`;
}
const ease = (x) => x * x * (3 - 2 * x);
const lineOff = (l, now) => l.from + (l.to - l.from) * ease(Math.min(1, Math.max(0, (now - l.moveAt) / l.moveT)));
const lineAlpha = (l, now) => {
  if (l.fadeAt) return Math.max(0, l.fadeFrom * (1 - (now - l.fadeAt) / MSG.gap));
  const x = (now - l.born) / MSG.life;
  return x >= 1 ? 0 : x < l.peak ? x / l.peak : 1 - (x - l.peak) / (1 - l.peak);
};
function drawMsgs(now) {
  const box = root?.querySelector('#plDmsg');
  if (!box) return;
  while (M.queue.length && M.queue[0].at < now - MSG.life) M.queue.shift();
  if (now - M.lastOut >= MSG.gap) {
    M.lastOut = now;
    M.recent.push(M.queue.length ? 1 : 0);
    if (M.recent.length > 48) M.recent.shift();
  }
  if (M.queue.length && M.lastOut === now) {
    const busy = M.recent.reduce((a, b) => a + b, 0) > 8;
    const { e } = M.queue.shift();
    while (M.lines.length < MSG.max) { const el = document.createElement('div'); el.className = 'pl-dmsg-l'; box.append(el); M.lines.push({ el, shown: false }); }
    for (const l of M.lines) if (l.shown && now > l.born && lineAlpha(l, now) <= 0) l.shown = false;
    const slot = M.lines.find((l) => !l.shown) || M.lines.reduce((a, b) => (b.to > a.to ? b : a));
    // 已有的行往上推一格，推到倒数第二格的开始淡出
    M.lines.filter((l) => l.shown && l !== slot).map((l) => [l, lineOff(l, now)]).sort((a, b) => a[1] - b[1]).forEach(([l, off], k) => {
      Object.assign(l, { from: off, to: (k + 1) * MSG.lineH, moveAt: now, moveT: busy ? MSG.busyMove : MSG.move });
      if (k === MSG.max - 2 && !l.fadeAt) Object.assign(l, { fadeAt: now, fadeFrom: lineAlpha(l, now) });
    });
    slot.el.innerHTML = msgHtml(e);
    Object.assign(slot, { shown: true, born: now, from: 0, to: 0, moveAt: now, moveT: MSG.move, fadeAt: 0, peak: busy ? MSG.busyPeak : MSG.peak });
    slot.el.style.display = 'block';
  }
  for (const l of M.lines) {
    if (!l.shown) continue;
    const a = lineAlpha(l, now);
    if (a <= 0 && now > l.born) { l.shown = false; l.el.style.display = 'none'; continue; }
    l.el.style.opacity = a.toFixed(3);
    l.el.style.transform = `translate(-50%, ${(-lineOff(l, now)).toFixed(1)}px)`;
  }
}
// 日志：所有回执、错误原因、击毁都只进「日志」窗口（客户端的报错走日志，不上屏）；窗口关着时来了错误，左侧栏日志按钮亮橙色指示
// 屏幕中上方的通知框（客户端 carbonui QuickMessage）：宽 300、水平居中，底边在 max(画面高 × 0.2, 175) 处；
// 底子是 MenuUnderlay（#0b0a12 模糊底 + 0.1 白边），出现时淡入 0.3 秒、高度 0.15 秒展开，每条新消息闪一下（0.3 秒），5 秒后关掉
function quickMsg(text) {
  const stage = root?.querySelector('#plStage');
  if (!stage) return;
  let el = stage.querySelector('.pl-qmsg');
  const fresh = !el;
  if (fresh) { el = document.createElement('div'); el.className = 'pl-qmsg'; el.innerHTML = '<i></i><p></p>'; stage.appendChild(el); }
  el.querySelector('p').textContent = tr(text);
  el.style.top = `${Math.max(0, Math.max(stage.clientHeight * 0.2, 175) - el.offsetHeight)}px`;
  const fl = el.querySelector('i');
  fl.style.animation = 'none'; void fl.offsetWidth; fl.style.animation = '';
  if (fresh) el.classList.add('in');
  clearTimeout(quickMsg.t);
  quickMsg.t = setTimeout(() => el.remove(), 5000);
}
function pushLog(text, kind = '') {
  // 失败提示（服务器回的 UserError，比如电容不够、目标太远、暂不支持）同时弹在屏幕上
  if (kind === 'bad') quickMsg(text);
  S.log.push({ t: S.b ? S.b.t : 0, text, kind });
  if (S.log.length > 200) S.log.shift();
  const w = root?.querySelector('[data-win="log"]');
  if (kind === 'bad' && w?.hidden) root.querySelector('[data-win-open="log"]')?.classList.add('imp');
  renderLog();
}
function renderLog() {
  const box = root?.querySelector('#plLog');
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = S.log.map((l) => `<div class="${l.kind}"><time>[${Math.floor(l.t / 60)}:${String(Math.floor(l.t % 60)).padStart(2, '0')}]</time> ${esc(tr(l.text))}</div>`).join('');
  if (near) box.scrollTop = box.scrollHeight;
}

// ---------- 无人机窗口（客户端 inflight/drones）：上段「挂舱中的无人机 (N)」、下段「太空中的无人机 (n/max)」----------
// 表头 24 高、白 0.05 底，左边 16px 折叠箭头，悬停时右边淡入按钮；两段不能同时折起来（折一段另一段自动展开）
// 太空中的行：状态图标 + 「名字 状态」（状态带颜色）+ 右边三条血（结构、装甲、护盾，各 32×4）
const DRONE_MAX = 5;   // maxActiveDrones：无人机操控 5 级 = 5 架（不是带宽）
function droneFold(which) {
  S.drFold = S.drFold === which ? null : which;
  const box = root?.querySelector('#plDrones');
  if (box) delete box.dataset.k;
  renderDrones();
}
function droneHp(d) {
  const mx = d.g.ent?.max || [1, 1, 1], hp = d.hp || mx;
  return [2, 1, 0].map((k) => Math.max(0, Math.min(1, hp[k] / (mx[k] || 1))));
}
function renderDrones() {
  const box = root?.querySelector('#plDrones'), u = S.me;
  if (!box || !u) return;
  // 下段列表最高 = 窗口高 − 128（客户端 dronesWindow）
  const wh = box.closest('[data-win]')?.offsetHeight || 216;
  box.style.setProperty('--botmax', `${Math.max(24, wh - 128)}px`);
  const out = Boolean(u.pilot.drones && u.alive);
  const bay = out ? [] : u.drones, space = out ? u.drones.filter((d) => d.pos) : [];
  const key = JSON.stringify([out, S.drFold, bay.length, space.map((d) => [d.g.type, d.target ? 1 : 0, droneHp(d).map((x) => Math.round(x * 64))])]);
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  const caret = (open) => `<img class="car" src="${UI}eveicon/system_icons/caret_${open ? 'down' : 'right'}_16px.png?v=1" alt="">`;
  const btn = (k, ic, hint) => `<button type="button" data-pl-drbtn="${k}" title="${esc(tr(hint))}">${CI(ic, 16)}</button>`;
  const none = `<div class="pl-dr-none">${esc(tr('没有物品'))}</div>`;
  // 挂舱：同类型叠在一起，「名字（n）」（全角括号，UI/Inflight/Drone/DroneBayEntryWithStacksize）
  const groups = new Map();
  for (const d of bay) groups.set(d.g.type, (groups.get(d.g.type) || 0) + 1);
  const bayRows = [...groups].map(([type, n]) => `<div class="pl-dr-row"><span>${esc(n > 1 ? `${typeName(type)}（${n}）` : typeName(type))}</span></div>`).join('') || none;
  // 状态（dronesConst）：空闲 绿 #8DC169（本地化原文就带「>」）、战斗中 红 #FF454B
  const st = (d) => (d.target ? ['战斗中', '#FF454B', `${UI}eveicon/control_icons/engage_target_16px.png`] : ['>空闲', '#8DC169', `${UI}eveicon/system_icons/hourglass_16px.png`]);
  const spaceRows = space.map((d) => {
    const [t, c, ic] = st(d);
    return `<div class="pl-dr-row sp"><img class="st" src="${ic}?v=1" alt=""><span>${esc(typeName(d.g.type))} <em style="color:${c}">${esc(tr(t))}</em></span><i class="hp">${droneHp(d).map((f) => `<b style="--f:${f.toFixed(3)}"></b>`).join('')}</i></div>`;
  }).join('') || none;
  const fb = S.drFold === 'bay', fs = S.drFold === 'space';
  box.innerHTML = `<div class="pl-dr-sec top${fb ? ' fold' : ''}"><div class="pl-dr-h" data-pl-drhead="bay">${caret(!fb)}<span>${esc(tr('挂舱中的无人机'))} (${bay.length})</span><span class="btns">${btn('launch', 'launch_drones', '释放无人机 (Shift + F)')}</span></div><div class="pl-dr-list">${fb ? '' : bayRows}</div></div>
    <div class="pl-dr-sec bot${fs ? ' fold' : ''}"><div class="pl-dr-h" data-pl-drhead="space">${caret(!fs)}<span>${esc(tr('太空中的无人机'))} (${space.length}/${DRONE_MAX})</span><span class="btns">${btn('engage', 'engage_target', '迎战目标')}<i class="sep"></i>${btn('recall', 'recall_drones', '返回至无人机挂舱 (Shift + R)')}</span></div><div class="pl-dr-list">${fs ? '' : spaceRows}</div></div>`;
}
function setDrones(on) {
  if (R.setDrones(on)) renderDrones();
}

// ---------- 舰船属性窗口（按装配、全部 5 级技能）----------
function renderShip() {
  const box = root?.querySelector('#plShip'), u = S.me;
  if (!box || !u) return;
  // 当前状态（装备开关、弹药、舰船模式、深渊天气都在 u.t 里），再乘引擎的实时系数（网 / 标记 / 抑阻、气云 / 塔）
  const t = u.t, M = (k) => u[k] ?? 1;
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const n = (x, d = 0) => ctx.formatNumber(Number((x || 0).toFixed(d)));
  // 推进器关 / 开两档：同装备提示的算法（超载按 overloadSpeedFactorBonus 放大速度加成那一段）
  let pv = null;
  if (S.prop >= 0 && S.variant) {
    const off = S.auto.filter((x) => !u.pilot.on.has(x) && x !== S.prop), ch = S.charges || {}, md = S.mode || undefined;
    const a = S.variant([...off, S.prop], ch, md), b = S.variant(off, ch, md);
    let v1 = b.vel;
    if (S.rk?.ovl.has(S.prop)) v1 = a.vel + (b.vel - a.vel) * (1 + (S.rk.heat[S.prop]?.spd || 0));
    pv = { v0: a.vel * M('velMult'), v1: v1 * M('velMult'), s0: a.sig * M('sigMult'), s1: b.sig * M('sigMult') };
  }
  const html = `<div class="pl-ship-head"><img src="${IMG(flyShip(), 'render', 64)}" alt=""><div><b>${esc(typeName(flyShip()))}</b><span>${esc(S.fitLabel || '')}</span></div></div>
    <table class="pl-kv">
      ${row('输出（DPS）', n(t.dps))}
      ${row('有效血量（EHP）', n(t.ehp))}
      ${row('最大速度', pv ? `${n(pv.v0)} m/s · 推进器开 ${n(pv.v1)} m/s` : `${n(t.vel * M('velMult'))} m/s`)}
      ${row('信号半径', pv ? `${n(pv.s0)} m · 推进器开 ${n(pv.s1)} m` : `${n(t.sig * M('sigMult'))} m`)}
      ${row('对准时间', `${((t.align || 0) * M('tauMult')).toFixed(1)} 秒`)}
      ${row('锁定距离', fmtDist((t.lockRange || 0) * M('rangeMult')))}
      ${row('扫描分辨率', `${n(t.scanRes * M('scanMult'))} mm`)}
      ${row('同时锁定', `${u.pilot.maxLocks} 个`)}
      ${row('电容', `${n(t.cap.max)} GJ`)}
    </table>`;
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
export const debugPilot = () => S;   // 调试用（控制台查看驾驶模拟状态）
