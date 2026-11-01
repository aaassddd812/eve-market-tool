// ===== 殖民地存量模拟（模板编辑器侧栏「产量」「存储与维护」用）=====
// 按编辑器自动生成的路由（采集控制器 → 仓储，工厂从仓储取料、产物送回仓储）逐段推演：
//   采集控制器的产量随采集程序时间衰减（常用的采集衰减曲线：1 / (1 + 0.012·t) 再叠加起伏，t 为 15 分钟一格），
//   按头一天的平均产量 = 设定的每头产量来定标；工厂按配方速率连续取料，缺料就按比例减产（断料）；
//   仓储（发射平台 10000 m³、储藏设施 12000 m³）装满后再送来的东西算损失（满仓）。
// 殖民地里不产的原料（买料加工）按「补货周期」开局装好：周期 = 容量 ÷ max(原料体积速率, 产物体积速率)，周期里两者都放得下。
// steady：按「按时补货、取走」持续运转来算产量——殖民地里不产的原料一直够、仓储不会满，只剩采集衰减和上游供不上带来的减产。
// 只是估算：游戏里工厂按整周期取料、采集产量还取决于热点位置。

const CAP = { launchpad: 10000, storage: 12000 };
const DT = 0.25;            // 推演步长（小时）
const DECAY = 0.012;        // 采集衰减系数（每 15 分钟一格）
const NOISE = 0.8;          // 采集起伏幅度

// 采集产量形状：t 小时时的相对产量（未定标）
function ecuShape(t, phase) {
  const b = t * 4;
  const wave = (Math.cos(phase + b / 12) + Math.cos(phase / 2 + b * 0.2) + Math.cos(b * 0.5)) / 3;
  return (1 / (1 + b * DECAY)) * (1 + NOISE * Math.max(0, wave));
}

// m：编辑器模型；info：autoRoutes(m) 的结果；env：schemByOut、pi.commodities；perHead：每头每小时平均产量；hours：推演时长
export function simulate(m, info, { env, perHead, hours, steady = false }) {
  const vol = (t) => env.pi.commodities[t]?.[3] || 0;
  const steps = Math.max(1, Math.round(hours / DT));
  const hubIdx = new Map();
  const hubs = [];
  const hubOf = (i) => {
    if (!hubIdx.has(i)) {
      hubIdx.set(i, hubs.length);
      hubs.push({ i, kind: m.pins[i].kind, cap: steady ? Infinity : CAP[m.pins[i].kind] || 10000, stock: new Map(), initial: new Map(), fill: new Float32Array(steps + 1), series: new Map(), fullAt: null, refill: null, ext: new Map(), made: new Set() });
    }
    return hubs[hubIdx.get(i)];
  };
  m.pins.forEach((p, i) => { if (CAP[p.kind]) hubOf(i); });

  // 采集控制器、工厂各自连到哪个仓储
  const ecus = [];
  const facs = new Map();
  for (const r of info.routes) {
    if (r.from != null && m.pins[r.from].kind === 'ecu') {
      const h = hubOf(r.path[r.path.length - 1]);
      const p = m.pins[r.from];
      const avg = p.heads * perHead;
      const phase = (avg / 4) ** 0.7;
      let mean = 0;
      for (let k = 0; k < 96; k++) mean += ecuShape((k + 0.5) / 4, phase);
      ecus.push({ i: r.from, h, type: r.type, avg, phase, mean: mean / 96 });
      h.made.add(r.type);
    } else if (r.to != null || r.from != null) {
      const i = r.to ?? r.from;
      const s = env.schemByOut.get(m.pins[i].product);
      if (!s) continue;
      const k = 3600 / s.cycle;
      if (!facs.has(i)) facs.set(i, { i, tier: 0, inputs: [], out: m.pins[i].product, outRate: s.outQty * k, h: null, starved: null });
      const f = facs.get(i);
      if (r.to === i) { f.inputs.push([r.type, r.qty * k]); f.h = f.h || hubOf(r.path[0]); }
      else { f.h = hubOf(r.path[r.path.length - 1]); f.h.made.add(r.type); }
    }
  }
  const factories = [...facs.values()].filter((f) => f.h);
  for (const f of factories) f.tier = env.tierOf(f.out);
  factories.sort((a, b) => a.tier - b.tier);

  // 理想速率（工厂满负荷、采集按头一天平均）：每种物品每小时产出 / 消耗
  const idealMade = new Map(), idealUsed = new Map();
  const add = (map, t, q) => map.set(t, (map.get(t) || 0) + q);
  for (const e of ecus) add(idealMade, e.type, e.avg);
  for (const f of factories) { add(idealMade, f.out, f.outRate); for (const [t, q] of f.inputs) add(idealUsed, t, q); }

  // 殖民地里不产的原料：开局装好一个补货周期的量
  for (const h of hubs) {
    let vin = 0, vout = 0;
    const need = new Map();
    for (const f of factories) if (f.h === h) for (const [t, q] of f.inputs) if (!h.made.has(t)) add(need, t, q);
    for (const [t, q] of need) { vin += q * vol(t); h.ext.set(t, q); }
    const madeHere = new Map();
    for (const e of ecus) if (e.h === h) add(madeHere, e.type, e.avg);
    for (const f of factories) if (f.h === h) { add(madeHere, f.out, f.outRate); for (const [t, q] of f.inputs) if (h.made.has(t)) add(madeHere, t, -q); }
    for (const [t, q] of madeHere) if (q > 0) vout += q * vol(t);
    if (vin > 0 && !steady) {
      h.refill = h.cap / Math.max(vin, vout);
      for (const [t, q] of need) { const n = Math.floor(q * h.refill); h.initial.set(t, n); h.stock.set(t, n); }
    }
  }

  const made = new Map(), used = new Map(), lost = new Map();
  const volume = (h) => { let v = 0; for (const [t, n] of h.stock) v += n * vol(t); return v; };
  const put = (h, t, n, at) => {
    const room = h.cap - volume(h);
    const fit = vol(t) > 0 ? Math.min(n, Math.max(0, room) / vol(t)) : n;
    if (fit < n - 1e-6) { add(lost, t, n - fit); if (h.fullAt == null) h.fullAt = at; }
    if (fit > 0) h.stock.set(t, (h.stock.get(t) || 0) + fit);
    add(made, t, fit);
    return fit;
  };
  const record = (k) => {
    for (const h of hubs) {
      h.fill[k] = volume(h);
      for (const [t, n] of h.stock) {
        if (!h.series.has(t)) h.series.set(t, new Float32Array(steps + 1));
        h.series.get(t)[k] = n;
      }
    }
  };
  record(0);
  for (let k = 0; k < steps; k++) {
    const t0 = k * DT, at = t0 + DT;
    if (steady) for (const h of hubs) for (const [t, q] of h.ext) h.stock.set(t, Math.max(h.stock.get(t) || 0, q * DT));
    for (const e of ecus) put(e.h, e.type, e.avg * (ecuShape(t0 + DT / 2, e.phase) / e.mean) * DT, at);
    for (const f of factories) {
      let u = 1, short = null;
      for (const [t, q] of f.inputs) {
        const have = f.h.stock.get(t) || 0;
        const r = have / (q * DT);
        if (r < u) { u = r; short = t; }
      }
      if (u < 0.999 && !f.starved) f.starved = { at: t0, type: short };
      if (u <= 0) continue;
      for (const [t, q] of f.inputs) { f.h.stock.set(t, (f.h.stock.get(t) || 0) - q * DT * u); add(used, t, q * DT * u); }
      put(f.h, f.out, f.outRate * DT * u, at);
    }
    record(k + 1);
  }
  return {
    hours: steps * DT, dt: DT, steps, hubs, made, used, lost, idealMade, idealUsed,
    starved: factories.filter((f) => f.starved).map((f) => ({ i: f.i, at: f.starved.at, type: f.starved.type, hub: f.h.i })),
    ecus: ecus.map((e) => ({ i: e.i, type: e.type }))
  };
}
