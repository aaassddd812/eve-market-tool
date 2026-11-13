// ===== 驾驶规则（驾驶模拟 pilot.js 和匹配服务器 server/match_service.mjs 共用）=====
// 一个玩家一份状态对象 S（字段名和 pilot.js 的 S 一样：b 战斗、me 自己的单位、on / off 装配属性、prop 推进器、auto 自身主动装备、
// rk 装备栏状态（编组、超载、过热、烧毁、停用中、等锁定）、charges 换过的弹药、bexp 指挥脉冲加成到期、modOn 开启时间、names 单位名字）。
// makeRules(S, hooks) 返回这一份状态上的全部规则；hooks：log(文字, 种类)、typeName(类型)、now()（画面时间，默认战斗时间）、lockOvl()（超载锁）、
// changed(种类)（装备栏 / 选中 / 无人机界面需要刷新）、rand()（过热掷骰，默认 Math.random）。
// 规则照客户端：开装备前的检查（NotEnoughEnergy、TargetTooFar 等）、停用要等这一轮跑完、超载按排积热按周期掷骰烧毁、换弹整组一起换并装填。
export const DT = 0.5;
export const RACKS = ['high', 'mid', 'low'];
export const fmtLeft = (sec) => { const s0 = Math.max(0, Math.ceil(sec)), m = Math.floor(s0 / 60); return m ? `${m}分 ${s0 % 60}秒` : `${s0}秒`; };
export const surf = (u, v) => Math.max(0, Math.hypot(v.pos[0] - u.pos[0], v.pos[1] - u.pos[1], v.pos[2] - u.pos[2]) - u.t.radius - (v.t?.radius || 0));
const AU = 149597870700;
export const fmtDist = (m) => (m < 10000 ? `${Math.round(m).toLocaleString('en-US')} m` : m < 0.1 * AU ? `${Math.round(m / 1000).toLocaleString('en-US')} km` : `${(m / AU).toFixed(1)} AU`);
// 指向性装备（要对着目标开的电子战），开之前 / 每个周期要查距离
const TARGETED = ['points', 'webs', 'paints', 'damps', 'ecms', 'neuts', 'noses', 'tds', 'gds', 'rcaps', 'rsbs', 'rtcs', 'fields'];
const TOGGLE = ['webs', 'points', 'paints', 'damps', 'ecms', 'neuts', 'noses', 'localReps', 'remote', 'injectors', 'smarts', 'bursts', 'tds', 'gds', 'rcaps', 'rsbs', 'rtcs', 'mjds', 'bubbles', 'fields'];

export function makeRules(S, H) {
  const log = (text, kind = '') => H.log?.(text, kind);
  const typeName = (id) => H.typeName?.(id) || '';
  const now = () => (H.now ? Math.min(H.now(), S.b.t) : S.b.t);
  const changed = (k) => H.changed?.(k);
  let rand = H.rand || Math.random;
  const nameOf = (v) => S.names?.[v.i] || '';

  // 开局第一步（建战斗前）：mine = pilotRow 的结果（row.unit 全开、off 推进器关、prop、mwd、variant）；返回放进战斗的单位属性（主动装备全关）
  function prep(mine) {
    S.on = mine.row.unit;
    S.off = mine.off || mine.row.unit;
    S.prop = mine.prop;
    S.mwd = Boolean(mine.mwd);   // 推进器是微型跃迁推进器：被扰频时关掉、开不起来
    S.variant = mine.variant || (() => S.on);
    // 自己身上的主动装备（推进器、抗性、感应增强器、跟踪电脑、损控等）：和游戏一样默认关着，玩家点了才开；开关时整船属性换成对应组合
    S.auto = (S.on.rack || []).map((_, k) => k).filter((k) => k === S.prop || (S.on.alwaysOn & (1 << k)));
    // 立体炸弹、ECM 脉冲、跃迁扰断力场、微跳：不用目标，目标没了也不停
    S.selfMods = new Set([...S.auto, ...['smarts', 'bursts', 'bubbles', 'mjds'].flatMap((k) => (S.on[k] || []).map((x) => x.m))]);
    S.ovCache = new Map();
    S.charges = {};
    S.bexp = new Map();   // 指挥脉冲波：每个周期开头把加成刷新到「这一轮开始 + buffDuration」，停了以后加成留到时间到为止
    S.calc = mine.row.calc;
    return S.variant(S.auto);
  }
  // 第二步（S.b 建好后）：接管第 i 个单位；grp = 存下来的编组
  function bind(i, maxLocks, grp) {
    S.me = S.b.takeControl(i, maxLocks);
    S.modOn = new Map();
    // 指向性装备（要对着目标开的电子战），开之前 / 每个周期要查距离
    S.me.pilot.targeted = new Set(TARGETED.flatMap((k) => (S.me.t[k] || []).map((x) => x.m)));
    S.lastAct = null;
    S.killN = 0;
    rackInit(grp);
    return S.me;
  }
  // 装备栏规则状态：编组 grp、超载 ovl、烧毁 burnt、热伤害 dmg、停用中 deact、等锁定 wait、超载周期累计 cyc、三排热量 h（散热 diss、发热倍数 gen）
  function rackInit(grp = new Map()) {
    const rack = S.on.rack || [];
    const heat = rack.map((m) => m.heat || { abs: 0, dmg: 0, hp: 40, spd: 0 });
    const ship = S.calc?.ship;
    const sa = (a, d) => ship?.attr(a) || d;
    S.rk = {
      grp, heat, ovl: new Set(), burnt: new Set(), dmg: new Map(), deact: new Map(), wait: new Set(), cyc: new Map(),
      h: [0, 0, 0], diss: [sa(1179, 0.01), sa(1196, 0.01), sa(1198, 0.01)], gen: sa(1224, 1),
    };
    S.me.pilot.ovl = S.rk.ovl;
  }
  const isGun = (i) => S.on.guns.some((g) => g.m === i);
  const sameKind = (a, b) => S.on.rack[a].type === S.on.rack[b].type && S.on.rack[a].charge === S.on.rack[b].charge;
  const masterOf = (i) => { for (const [m, sl] of S.rk.grp) if (m === i || sl.includes(i)) return m; return i; };
  const members = (i) => { const m = masterOf(i); return [m, ...(S.rk.grp.get(m) || [])]; };
  const canOverload = (i) => (S.on.rack[i]?.heat?.dmg || 0) > 0 && toggleable().has(i);
  // 编组：[[主武器, [从武器…]]]，只收同型号同弹药的武器；编组后组里每件的开关、超载状态跟主武器一致
  function setGroups(list) {
    const grp = new Map();
    const used = new Set();
    for (const [m, sl] of list || []) {
      if (!isGun(m) || used.has(m) || S.rk.burnt.has(m)) continue;
      const ok = (sl || []).filter((x) => x !== m && isGun(x) && sameKind(m, x) && !used.has(x) && !S.rk.burnt.has(x));
      if (!ok.length) continue;
      grp.set(m, ok);
      used.add(m); ok.forEach((x) => used.add(x));
    }
    S.rk.grp = grp;
    syncGroupState();
    return grp;
  }
  // 编组后组里每件的开关、超载状态跟主武器一致
  function syncGroupState() {
    const P = S.me.pilot;
    for (const [m, sl] of S.rk.grp) for (const x of sl) {
      if (P.on.has(m)) P.on.add(x); else P.on.delete(x);
      if (S.rk.ovl.has(m)) S.rk.ovl.add(x); else S.rk.ovl.delete(x);
    }
  }

  // 主动装备开关：换成对应的属性（速度、信号半径、抗性、锁定、电容消耗…）；停用后这一轮跑完才失效
  function beforeStep() {
    const u = S.me;
    if (!u?.alive || (!S.auto?.length && !Object.keys(S.charges || {}).length)) return;
    const P = u.pilot, t = S.b.t;
    const isOn = (i) => P.on.has(i) || (S.rk?.deact.get(i)?.end > t) || S.bexp?.get(i) > t;
    const off = S.auto.filter((i) => !isOn(i));
    let x = S.variant(off, S.charges || {});
    // 推进器超载：速度加成那一段按 overloadSpeedFactorBonus 放大
    if (S.prop >= 0 && isOn(S.prop) && S.rk?.ovl.has(S.prop)) {
      const k = off.join(',');
      if (!S.ovCache.has(k)) { const base = S.variant([...off, S.prop], S.charges || {}), b = S.rk.heat[S.prop].spd; S.ovCache.set(k, { ...x, vel: base.vel + (x.vel - base.vel) * (1 + b) }); }
      x = S.ovCache.get(k);
    }
    u.t = x;
  }
  function afterStep() {
    const u = S.me;
    if (!u) return;
    // 引擎在周期开头停掉的装备（电容不够 / 目标太远）：整组一起停，日志里写客户端的原话
    const Pm = u.pilot;
    if (Pm.msgs?.length) {
      for (const x of Pm.msgs.splice(0)) {
        if (!S.rk) continue;
        for (const y of members(x.i)) Pm.on.delete(y);
        const name = typeName(S.on.rack[x.i]?.type);
        if (x.k === 'cap') log(`${name}需要${x.need.toFixed(1)}单位电荷。电容器只有${Math.max(0, x.got).toFixed(1)}单位。`, 'bad');
        else if (x.k === 'mjd') log(`${name}：跳跃完成`, 'good');
        else if (x.k === 'mjdScram') log(`${name}因跃迁扰频而停止运转`, 'bad');
        else if (x.k === 'decloak') log('由于附近物体的影响，你的隐形状态已解除。', 'bad');   // 官方原文 #581396
        else log(`${nameOf(x.v)}距离太远，无法对其使用${name}，目标必须在${Math.round(x.rng).toLocaleString('en-US')}米内。`, 'bad');
      }
    }
    rackStep();
    // 指挥脉冲波：开着的每轮开头刷新加成到期时间
    const bt = S.b.t;
    if (u.alive) for (const i of Pm.on) {
      const bu = S.on.rack[i]?.burst;
      if (!bu?.dur) continue;
      const cs = cycStart(i, bt);
      if (cs != null && cs + bu.dur > (S.bexp.get(i) || 0)) S.bexp.set(i, cs + bu.dur);
    }
    // 被跃迁扰频：微型跃迁推进器立即停机（客户端：服务器把装备停掉，日志里一条通知）
    if (u.scram && S.mwd && S.prop >= 0 && (Pm.on.has(S.prop) || S.rk?.wait.has(S.prop))) {
      for (const x of members(S.prop)) { Pm.on.delete(x); S.rk?.deact.delete(x); S.rk?.wait.delete(x); }
      log(`${typeName(S.on.rack[S.prop].type)}因跃迁扰频而停止运转`, 'bad');
    }
    // 当前目标被打掉：武器、电子战自动停下（和游戏一样），推进器、维修不变
    if (S.lastAct && S.lastAct !== Pm.active && !S.lastAct.alive) {
      for (const m of [...Pm.on]) if (!S.selfMods.has(m) && !(u.t.localReps || []).some((x) => x.m === m)) Pm.on.delete(m);
    }
    S.lastAct = Pm.active;
  }
  // 超载：每排按开着的超载装备积热（吸热速度 × 发热倍数），按散热速度回落；每个超载周期按这一排的热量几率受一次热伤害，到耐久就烧毁
  function rackStep() {
    const u = S.me, rk = S.rk;
    if (!u || !rk) return;
    const P = u.pilot, t = S.b.t;
    if (rk.wait.size && P.active) { for (const i of rk.wait) activate(i); rk.wait.clear(); }
    for (const [i, d] of rk.deact) if (d.end <= t) rk.deact.delete(i);
    const rack = S.on.rack;
    for (let r = 0; r < 3; r++) {
      let gen = 0;
      rack.forEach((m, i) => { if (m.slot === RACKS[r] && rk.ovl.has(i) && P.on.has(i)) gen += rk.heat[i].abs * rk.gen; });
      rk.h[r] = Math.max(0, Math.min(1, rk.h[r] + (gen - rk.diss[r] * rk.h[r]) * DT));
    }
    for (const i of rk.ovl) {
      if (!P.on.has(i) || !u.alive) continue;
      const cyc = rack[i].cycle || 5;
      const acc = (rk.cyc.get(i) || 0) + DT;
      if (acc < cyc) { rk.cyc.set(i, acc); continue; }
      rk.cyc.set(i, acc - cyc);
      const h = rk.h[RACKS.indexOf(rack[i].slot)];
      if (rand() < h) rk.dmg.set(i, (rk.dmg.get(i) || 0) + rk.heat[i].dmg);
      if ((rk.dmg.get(i) || 0) >= rk.heat[i].hp) {
        rk.burnt.add(i); rk.ovl.delete(i); P.on.delete(i);
        log(`${typeName(rack[i].type)} 过热烧毁`, 'bad');
      }
    }
  }

  // ---------- 开关装备 ----------
  function toggleModule(m, shift = false) {
    const u = S.me;
    if (!u?.alive || !S.rk) return;
    const P = u.pilot, rk = S.rk;
    if (!toggleable().has(m)) return;
    m = masterOf(m);
    // Shift + 点击：切换超载（客户端一样）
    if (shift) { if (!H.lockOvl?.()) toggleOverload(m); return; }
    if (rk.burnt.has(m)) { log(`${typeName(S.on.rack[m].type)} 已烧毁`, 'bad'); return; }
    const grp = members(m).filter((x) => !rk.burnt.has(x));
    if (rk.wait.has(m)) { for (const x of grp) rk.wait.delete(x); return; }
    if (P.on.has(m)) {
      // 停用：这一轮跑完才真正停（红光闪），武器这期间不再开火
      const t = now();
      for (const x of grp) {
        const cyc = cycleOf(x);
        const t0 = cycStart(x, t);
        if (cyc > 0 && t0 != null && t - t0 < cyc) rk.deact.set(x, { t0, cyc, end: t0 + cyc });
        P.on.delete(x);
      }
      return;
    }
    // 武器、电子战要先有锁定好的目标（推进器、本地维修不用）；没目标就等着，锁上了自动开
    const self = S.selfMods.has(m) || [...(u.t.localReps || []), ...(u.t.injectors || [])].some((x) => x.m === m);
    if (!self && !P.active) { for (const x of grp) rk.wait.add(x); return; }
    if (grp.some((x) => rk.deact.get(x)?.end > S.b.t)) return;
    activate(m);
  }
  // 开装备前的检查（服务器在客户端按下时回的错误）：电容不够 → NotEnoughEnergy；指向性、不带失准的装备目标超出最远距离 → TargetTooFar
  function canActivate(m) {
    const u = S.me, P = u.pilot, x = S.on.rack[m];
    if (!x) return false;
    if (m === S.prop && S.mwd && u.scram) { log(`你的舰船正被跃迁扰频，无法启动${typeName(x.type)}`, 'bad'); return false; }
    // 微型跃迁引擎：被扰频开不起来；跳过之后要等重启延迟
    if ((u.t.mjds || []).some((y) => y.m === m)) {
      if (u.scram) { log(`你的舰船正被跃迁扰频，无法启动${typeName(x.type)}`, 'bad'); return false; }
      const left = (P.cool?.get(m) || 0) - S.b.t;
      if (left > 0) { log(`${typeName(x.type)}还需要${fmtLeft(left)}才能再次启动`, 'bad'); return false; }
    }
    // 隐形装置：2000 米内有别的物体开不了；关掉后要等重启延迟。隐形时开别的装备 = 先解除隐形
    if ((u.t.cloaks || []).some((y) => y.m === m)) {
      const left = (P.cool?.get(m) || 0) - S.b.t;
      if (left > 0) { log(`${typeName(x.type)}还需要${fmtLeft(left)}才能再次启动`, 'bad'); return false; }
      if (S.b.cloakNear(u)) { log(`距离其他物体太近（2000米内），无法启动${typeName(x.type)}`, 'bad'); return false; }
      // 官方提示原文（#260089 / #260090）：被别人锁定、自己锁着目标都不能隐形
      if (S.b.units.some((v) => v.alive && v !== u && ((v.target === u && v.lock <= 0) || v.pilot?.locks?.get(u) === 0))) { log('当你被别人锁定时，无法将飞船隐形。', 'bad'); return false; }
      if (P.locks.size) { log('当你有锁定的目标时，无法将飞船隐形。', 'bad'); return false; }
    } else if (u.cloak) for (const y of u.t.cloaks || []) P.on.delete(y.m);
    const g = u.t.guns.find((y) => y.m === m);
    const need = g ? g.capNeed : (u.t.localReps || []).some((y) => y.m === m && y.charged) ? 0 : x.cap || 0;
    if (need > 0 && u.cap < need) { log(`${typeName(x.type)}需要${need.toFixed(1)}单位电荷。电容器只有${Math.max(0, u.cap).toFixed(1)}单位。`, 'bad'); return false; }
    if (P.targeted?.has(m) && !(x.fall > 0) && x.rng > 0 && P.active) {
      const d = surf(u, P.active);
      if (d > x.rng) { log(`${nameOf(P.active)}距离太远，无法对其使用${typeName(x.type)}，目标必须在${Math.round(x.rng).toLocaleString('en-US')}米内。`, 'bad'); return false; }
    }
    return true;
  }
  function activate(m) {
    if (!canActivate(m)) return;
    const P = S.me.pilot;
    for (const x of members(m)) {
      if (S.rk.burnt.has(x)) continue;
      P.on.add(x);
      S.modOn.set(x, now());
    }
  }
  const cycleOf = (i) => {
    const u = S.me, g = u.t.guns.find((x) => x.m === i);
    if (g) return g.cycle;
    return (u.t.injectors || []).find((x) => x.m === i)?.cycle || (u.t.localReps || []).find((x) => x.m === i)?.cycle || S.on.rack[i]?.cycle || 0;
  };
  // 这一轮是什么时候开始的
  function cycStart(i, t) {
    const u = S.me, gk = u.t.guns.findIndex((g) => g.m === i);
    if (gk >= 0) { const st = u.guns[gk]; return t >= st.last ? st.last : st.last - (st.next - st.last); }
    const cyc = cycleOf(i), t0 = S.modOn.get(i);
    if (t0 == null || !cyc) return null;
    return t - ((((t - t0) % cyc) + cyc) % cyc);
  }
  // 能手动开关的装备：武器、电子战、维修、推进器，以及自己身上的其他主动装备（抗性、感应增强器等，S.auto）
  let toggleCache = null;
  function toggleable() {
    if (toggleCache?.t === S.on) return toggleCache.set;
    const t = S.on, set = new Set();
    for (const g of t.guns) if (g.m != null) set.add(g.m);
    for (const k of TOGGLE) for (const x of t[k] || []) if (x.m != null) set.add(x.m);
    for (const i of S.auto || []) set.add(i);
    toggleCache = { t, set };
    return set;
  }
  // ---------- 超载 ----------
  function toggleOverload(i) {
    if (!canOverload(i) || S.rk.burnt.has(i)) return;
    const on = !S.rk.ovl.has(masterOf(i));
    for (const x of members(i)) { if (on && !S.rk.burnt.has(x)) S.rk.ovl.add(x); else S.rk.ovl.delete(x); }
  }
  // 整排超载按的是装备真实所在的槽位排（服务器 OverloadRack）
  const rackMods = (r) => (S.on.rack || []).map((_, i) => i).filter((i) => S.on.rack[i].slot === r && masterOf(i) === i);
  function setRackOverload(r, on) {
    for (const i of rackMods(r).filter((x) => canOverload(x) && !S.rk.burnt.has(x))) {
      for (const x of members(i)) { if (on && !S.rk.burnt.has(x)) S.rk.ovl.add(x); else S.rk.ovl.delete(x); }
    }
  }
  function toggleRackOverload(r) {
    const list = rackMods(r).filter((i) => canOverload(i) && !S.rk.burnt.has(i));
    const all = list.length && list.every((i) => S.rk.ovl.has(i));
    for (const i of list) for (const x of members(i)) { if (all) S.rk.ovl.delete(x); else if (!S.rk.burnt.has(x)) S.rk.ovl.add(x); }
  }
  // ---------- 弹药 ----------
  // 能装的弹药由调用方查（装配数据）；这里只换：整组一起换，换上就开始装填（重新装填时间），装填期间不开火
  function setAmmo(m, type) {
    S.charges = { ...(S.charges || {}) };
    for (const x of members(m)) S.charges[x] = type;
    S.ovCache.clear();
    beforeStep();
    log(`正在为${typeName(S.on.rack[m].type)}装填${typeName(type)}`, 'sys');
    reloadMods(members(m), true);
  }
  function reloadMods(list, quiet = false) {
    const u = S.me, t = S.b.t;
    let n = 0;
    for (const x of list) {
      const k = u.t.guns.findIndex((g) => g.m === x);
      if (k < 0 || !u.guns[k]) continue;
      const g = u.t.guns[k], st = u.guns[k];
      if (!Number.isFinite(g.ammo) && !quiet) continue;
      st.ammo = g.ammo;
      st.reloadUntil = st.next = t + (g.reload || 10);
      n++;
    }
    if (n && !quiet) log('重新装填', 'sys');
  }
  // ---------- 锁定、飞行、无人机 ----------
  function lock(v) {
    const u = S.me;
    if (!v || v === u || !u?.alive || !v.alive) return;
    const P = u.pilot;
    if (P.locks.has(v)) { P.active = v; return; }
    if (P.locks.size >= P.maxLocks) { log(`最多同时锁定 ${P.maxLocks} 个目标`, 'bad'); return; }
    if (u.cloak) { log('隐形状态下无法锁定目标', 'bad'); return; }
    if ((P.lockBlock || 0) > S.b.t) { log(`刚解除隐形，还需要${fmtLeft(P.lockBlock - S.b.t)}才能锁定目标`, 'bad'); return; }
    if (!S.b.lock(u, v)) { log(`${nameOf(v)} 超出锁定距离（${fmtDist(u.t.lockRange * u.rangeMult)}）`, 'bad'); return; }
    log(`开始锁定 ${nameOf(v)}`, 'sys');
  }
  function unlock(v) {
    if (!v || !S.me) return;
    S.b.unlock(S.me, v);
    log(`解除锁定 ${nameOf(v)}`, 'sys');
  }
  // 飞行指令：{ cmd: stop|approach|orbit|keep|dir|point, tgt, dist, dir, point }
  function cmd(c) {
    const P = S.me?.pilot;
    if (!P || !S.me.alive) return false;
    Object.assign(P, c);
    if (c.cmd !== 'stop' && P.speed === 0) P.speed = 1;
    return true;
  }
  // 速度表：0～1；停着的时候拉速度朝船头方向（在动就按当前方向）飞
  function setSpeed(frac) {
    const P = S.me?.pilot;
    if (!P) return;
    if (frac <= 0) { cmd({ cmd: 'stop', tgt: null }); return; }
    P.speed = frac;
    if (P.cmd === 'stop') { const fw = Math.hypot(...S.me.vel) > 1 ? S.me.vel : S.me.face; const l = Math.hypot(...fw) || 1; Object.assign(P, { cmd: 'dir', dir: fw.map((x) => x / l) }); }
  }
  function setDrones(on) {
    const u = S.me;
    if (!u?.alive || !u.drones.length) return false;
    u.pilot.drones = on;
    log(on ? '放出无人机' : '收回无人机', 'sys');
    return true;
  }
  return {
    prep, bind, rackInit, syncGroupState, setGroups, masterOf, members, canOverload, isGun, sameKind,
    beforeStep, afterStep, rackStep, toggleModule, canActivate, activate, cycleOf, cycStart, toggleable,
    toggleOverload, setRackOverload, toggleRackOverload, setAmmo, reloadMods, lock, unlock, cmd, setSpeed, setDrones, changed,
    setRand: (f) => { rand = f || Math.random; },
  };
}

// ===== 匹配模式（服务器 server/match_worker.mjs 和客户端 pilot.js 用同一份）=====
// 舰船级别：同级别才匹配（T1、T2 同级）；旗舰、工业、穿梭机、太空舱、游艇等不参加。组 ID 取自 SDE groups
export const MATCH_BRACKETS = {
  frigate: { name: '护卫舰', dist: 20, groups: [25, 237, 324, 830, 831, 834, 893, 1283, 1527] },
  destroyer: { name: '驱逐舰', dist: 20, groups: [420, 541, 1305, 1534] },
  cruiser: { name: '巡洋舰', dist: 30, groups: [26, 358, 832, 833, 894, 906, 963, 1972] },
  battlecruiser: { name: '战列巡洋舰', dist: 40, groups: [419, 540, 1201] },
  battleship: { name: '战列舰', dist: 50, groups: [27, 898, 900] },
};
export const bracketOf = (group) => Object.keys(MATCH_BRACKETS).find((k) => MATCH_BRACKETS[k].groups.includes(group)) || null;
// 装配价值上限（ISK，0 = 不限）
export const MATCH_CAPS = [50e6, 200e6, 0];
export const MATCH_MAX = 600;   // 一局最长 10 分钟
// 战斗参数：服务器、客户端必须完全一样（同一个种子才能算出同样的结果）
export const matchBattleOpt = (seed, dist) => ({ dist, moveA: 'orbit', moveB: 'orbit', focus: 'weak', logi: true, ewar: true, cap: true, max: MATCH_MAX + 1, record: true, droneUnits: true, seed });
export function seededRand(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
// 玩家指令（客户端发给服务器，服务器盖上步数后原样发给所有人，各自用 applyOp 执行）：
//   lock / unlock { u } · tog { m, shift } · ammo { m, type } · reload { list } · cmd { cmd, u, dist, dir, pt } · speed { f } · drones { on }
//   groups { list: [[主, [从…]]] } · rov { r, on（省略 = 切换） } · ov { m }
const CMDS = ['stop', 'approach', 'orbit', 'keep', 'dir', 'point'];
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(fin);
const idx = (x, n) => Number.isInteger(x) && x >= 0 && x < n;
// 格式检查（服务器收到时查一遍；内容合不合规则由规则函数自己判断）：返回整理过的指令或 null
export function cleanOp(a, nUnits, nRack) {
  if (!a || typeof a !== 'object') return null;
  switch (a.a) {
    case 'lock': case 'unlock': return idx(a.u, nUnits) ? { a: a.a, u: a.u } : null;
    case 'tog': return idx(a.m, nRack) ? { a: 'tog', m: a.m, shift: Boolean(a.shift) } : null;
    case 'ov': return idx(a.m, nRack) ? { a: 'ov', m: a.m } : null;
    case 'ammo': return idx(a.m, nRack) && Number.isInteger(a.type) && a.type > 0 ? { a: 'ammo', m: a.m, type: a.type } : null;
    case 'reload': return Array.isArray(a.list) && a.list.length <= nRack && a.list.every((x) => idx(x, nRack)) ? { a: 'reload', list: [...new Set(a.list)] } : null;
    case 'speed': return fin(a.f) ? { a: 'speed', f: Math.max(0, Math.min(1, a.f)) } : null;
    case 'drones': return { a: 'drones', on: Boolean(a.on) };
    case 'rov': return RACKS.includes(a.r) ? { a: 'rov', r: a.r, ...(a.on == null ? {} : { on: Boolean(a.on) }) } : null;
    case 'groups': return Array.isArray(a.list) && a.list.length <= nRack && a.list.every((g) => Array.isArray(g) && idx(g[0], nRack) && Array.isArray(g[1]) && g[1].length < nRack && g[1].every((x) => idx(x, nRack)))
      ? { a: 'groups', list: a.list.map(([m, sl]) => [m, sl.slice()]) } : null;
    case 'cmd': {
      if (!CMDS.includes(a.cmd)) return null;
      const o = { a: 'cmd', cmd: a.cmd };
      if (a.u != null) { if (!idx(a.u, nUnits)) return null; o.u = a.u; }
      if (a.dist != null) { if (!fin(a.dist)) return null; o.dist = Math.max(0, Math.min(300000, a.dist)); }
      if (a.cmd === 'dir') { if (!vec(a.dir)) return null; const l = Math.hypot(...a.dir) || 1; o.dir = a.dir.map((x) => x / l); }
      if (a.cmd === 'point') { if (!vec(a.pt)) return null; o.pt = a.pt.slice(); }
      return o;
    }
    default: return null;
  }
}
// 执行一条指令（R = 这个玩家的 makeRules，S = 他的状态对象）
export function applyOp(R, S, a) {
  const U = (i) => (i == null ? null : S.b.units[i] || null);
  switch (a.a) {
    case 'lock': return R.lock(U(a.u));
    case 'unlock': return R.unlock(U(a.u));
    case 'tog': return R.toggleModule(a.m, a.shift);
    case 'ov': return R.toggleOverload(a.m);
    case 'ammo': return S.on.rack[a.m] ? R.setAmmo(a.m, a.type) : null;
    case 'reload': return R.reloadMods(a.list);
    case 'speed': return R.setSpeed(a.f);
    case 'drones': return R.setDrones(a.on);
    case 'rov': return a.on == null ? R.toggleRackOverload(a.r) : R.setRackOverload(a.r, a.on);
    case 'groups': return R.setGroups(a.list);
    case 'cmd': {
      const c = { cmd: a.cmd, tgt: U(a.u) };
      if (a.dist != null) c.dist = a.dist;
      if (a.dir) c.dir = a.dir;
      if (a.pt) c.pt = a.pt;
      if (a.cmd === 'stop') return R.cmd({ cmd: 'stop', tgt: null });
      return R.cmd(c);
    }
    default: return null;
  }
}
// 每个玩家装备栏里服务器说了算的部分（过热掷骰的结果）：客户端每步之后覆盖
export const rackSnap = (S) => (S.rk ? { b: [...S.rk.burnt], h: S.rk.h.slice(), d: [...S.rk.dmg] } : null);
export function applyRackSnap(S, x) {
  if (!S.rk || !x) return;
  const P = S.me.pilot;
  for (const i of x.b) if (!S.rk.burnt.has(i)) { S.rk.burnt.add(i); S.rk.ovl.delete(i); P.on.delete(i); }
  S.rk.h = x.h.slice();
  S.rk.dmg = new Map(x.d);
}
