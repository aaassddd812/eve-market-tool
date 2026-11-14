// ===== 匹配对局的建局和每一步（服务器 server/match_worker.mjs、客户端 pilot.js 共用，两边必须完全一样）=====
// info = 服务器发下来的对局信息 { seed, dist, players: [{ p, side, name, fit, levels }] }（fit 是服务器检查过的装配，levels 是角色真实技能）。
// 单位序号：A 方玩家在前，同方按 p 顺序；每个玩家一份规则状态（pilot-rules makeRules），客户端自己那份用页面的 S 和带日志的规则。
import * as PR from './pilot-rules.js?v=v5';

// deps = { pilotUnit（sim-unit）, createBattle（sim-engine）, systems（pilot-systems.json，跃迁目的地；没有就没有天体）, en（英文界面：天体用英文名） }；pick(p) 可返回 { S, R } 替换某个玩家的状态和规则；opt = 额外战斗参数（客户端的命中回调）
export function buildMatch(deps, info, pick = () => null, opt = {}) {
  const P = info.players.map((pl) => {
    const mine = deps.pilotUnit(pl.fit, { skills: new Map(pl.levels), self: true });
    const own = pick(pl.p);
    const S = own?.S || { names: [], b: null };
    const R = own?.R || PR.makeRules(S, {});
    // 过热掷骰：每个玩家一条固定种子的随机数（服务器另外每步下发结果）
    R.setRand(PR.seededRand(info.seed + 7919 * (pl.p + 1)));
    const row = { id: pl.p + 1, ship: pl.fit.ship, count: 1, fit: mine.fit, calc: mine.calc, stats: mine.stats, unit: null, label: pl.name };
    row.unit = R.prep({ row: { ...row, unit: mine.unit }, off: mine.off, prop: mine.prop, variant: mine.variant, mwd: mine.mwd });
    return { ...pl, S, R, row, calc: mine.calc, nRack: mine.unit?.rack?.length || 0 };
  });
  const order = [...P.filter((x) => x.side === 'A'), ...P.filter((x) => x.side === 'B')];
  const b = deps.createBattle({ A: order.filter((x) => x.side === 'A').map((x) => x.row), B: order.filter((x) => x.side === 'B').map((x) => x.row) }, { ...PR.matchBattleOpt(info.seed, info.dist, PR.celOf(deps.systems?.systems?.[PR.matchSky(info.seed)], deps.systems?.types, deps.en ? deps.systems?.typesEn : null)), ...opt });
  order.forEach((x, i) => {
    x.S.b = b;
    const maxLocks = Math.max(1, Math.min(x.calc?.ship?.attr(192) || 5, x.calc?.char?.attr(192) || 5));
    x.R.bind(i, maxLocks);
    x.unit = i;
  });
  return { b, P, k: 0 };
}
// 走一步：先按顺序执行这一步的指令 [[p, 指令]]，再所有人 beforeStep → 引擎一步 → 所有人 afterStep（after(p) 可替换某人的 afterStep）
export function stepMatch(M, ops, after = () => null) {
  for (const [p, a] of ops) { const x = M.P[p]; if (x) PR.applyOp(x.R, x.S, a); }
  for (const x of M.P) x.R.beforeStep();
  M.b.step();
  for (const x of M.P) (after(x.p) || x.R.afterStep)();
  M.k++;
}
