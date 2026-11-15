// 读船体子特效（SOF 船体 children / childSets 引用的 .red，这里读同名 .black）里的动态灯。
// 单独一个进程，原因同 hull-locators.mjs。
// 客户端（carbon-trinity EveChildContainer::GetLights / EveChildMesh / Tr2Light::AddLight）：
//   每层子对象世界矩阵 = TransformationMatrix(scaling, rotation, translation) × 父矩阵；
//   容器里的灯：AddLight(灯, 世界矩阵, parentScale = 世界矩阵三轴长度的平均)；网格里的灯 parentScale = 1；
//   LightData::AsPerPointLightData：位置 = 世界矩阵 × position，半径 / 内半径 × parentScale，
//     颜色 = color × brightness（× 噪声），聚光方向 = 世界矩阵 × (rotation × (0, 0, −1))，外 / 内角为度数。
// 灯的 color / brightness / radius / innerRadius 常被曲线集（TriCurveSet）绑定：只看会自动播放的（playOnLoad 不为 false），
//   求值规则见 js/sim-curves.js。EveChildInheritProperties（SOF 按阵营色表填）在这里按该外观的色表换成常量。
//   按若干时刻采样：结果不随时间变的直接烘成常量；变的导出绑定图（graph），网页逐帧求值。
//   Tr2FactionLight：颜色 = Saturate(色表[selectedColor], saturation)（Saturate 实现不在源码里，按 Mixer 同样的亮度去饱和处理）。
// 输入（stdin）：{ 外观键: { files: [{ file: 本地 .black, t, r, s（SOF children 项的平移 / 旋转 / 缩放） }], cs: 阵营色表（44 个 rgba） } }
// 输出（stdout）：{ 外观键: { lights: [...], graph: { sets, n } | null, types, unhandled, stats } }，坐标为船体坐标
//   每盏灯：{ p, R, ri, c（已乘 brightness；动态灯是参考值）, dir, co, ci, na, nf, no, ies, a: null | { b: { 属性: 绑定 }, c0, br0, R0, ri0, ps } }
import { readFileSync } from 'node:fs';
import { prepScalar, createGraph } from '../../js/sim-curves.js';

await import('@carbonenginejs/runtime');
const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');

// 列主序 4×4（列向量），和 three / gl 一样
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function srt(o) {
  const s = Array.from(o.scaling || [1, 1, 1]), [x, y, z, w] = Array.from(o.rotation || [0, 0, 0, 1]), t = Array.from(o.translation || [0, 0, 0]);
  const m = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y), 0,
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x), 0,
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}
const local = (o) => (o.useSRT === false && o.localTransform?.length === 16 ? Array.from(o.localTransform) : srt(o));
const xp = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const xd = (m, d) => [0, 1, 2].map((r) => m[r] * d[0] + m[4 + r] * d[1] + m[8 + r] * d[2]);
const axisAvg = (m) => (Math.hypot(m[0], m[1], m[2]) + Math.hypot(m[4], m[5], m[6]) + Math.hypot(m[8], m[9], m[10])) / 3;
function quatDir(q) {   // 旋转 (0, 0, −1)
  const [x, y, z, w] = Array.from(q || [0, 0, 0, 1]);
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
const f4 = (x) => +(+x).toFixed(4);
const arr = (v, d) => (v == null ? d : ArrayBuffer.isView(v) || Array.isArray(v) ? Array.from(v).map(Number) : d);
const sat = (c, s) => { if (s === 1) return c; const g = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114; return c.map((x) => g + (x - g) * Math.max(0, s)); };
const INHERIT = ['Primary', 'Secondary', 'Tertiary', 'Black', 'White', 'Yellow', 'Orange', 'Red', 'Blue', 'Green', 'Cyan', 'Fire', 'Hull', 'Glass', 'Reactor', 'Darkhull', 'Booster', 'Killmark', 'PrimaryLight', 'SecondaryLight', 'TertiaryLight', 'WhiteLight', 'PrimaryHologram', 'SecondaryHologram', 'TertiaryHologram', 'State0', 'State1', 'State2', 'State3', 'StateVulnerable', 'StateInvulnerable', 'PrimaryForcefield', 'SecondaryForcefield', 'PrimaryBanner', 'PrimaryFx', 'SecondaryFx', 'PrimarySpotlight', 'SecondarySpotlight', 'TertiarySpotlight', 'PrimaryBillboard', 'PrimaryWarpFx', 'PrimaryAttackFx', 'PrimarySiegeFx', 'PrimaryDockedFx'];
const LIGHT_ATTRS = ['color', 'brightness', 'radius', 'innerRadius'];
const SAMPLE_T = [0, 0.37, 1.1, 2.9, 5.3, 7.7, 13.1, 21.7, 34.3, 61.9];

const parsed = new Map();
async function readBlack(file) {
  if (!parsed.has(file)) parsed.set(file, await CjsBlackFormat.read(new Uint8Array(readFileSync(file))));
  return parsed.get(file);
}

const jobs = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
for (const [key, job] of Object.entries(jobs)) {
  const cs = job.cs || [];
  const N = [], sets = [], types = {}, unhandled = {}, lights = [];
  const stats = { lights: 0, baked: 0, anim: 0 };
  for (const fj of job.files) {
    try {
      const root = (await readBlack(fj.file)).object;
      const ids = new Map(); const seen = new Set();
      const idw = (o) => { if (!o || typeof o !== 'object' || ArrayBuffer.isView(o) || seen.has(o)) return; seen.add(o); if (o._id != null) ids.set(o._id, o); for (const v of Object.values(o)) idw(v); };
      idw(root);
      const deref = (x) => (x && x._ref != null ? ids.get(x._ref) : x);
      // 自动播放的曲线集：曲线 → 曲线集序号；绑定：目标对象 → { 属性: 绑定 }（后面的覆盖前面的）
      const setOf = new Map(), binds = new Map();
      const seenO = new Set();
      const collect = (o) => {
        o = deref(o);
        if (!o || typeof o !== 'object' || seenO.has(o)) return; seenO.add(o);
        for (const c0 of o.curveSets || []) {
          const c = deref(c0);
          if (!c || c.playOnLoad === false) continue;
          const si = sets.push(+(c.scale ?? 1)) - 1;
          for (const cv of c.curves || []) { const x = deref(cv); if (x) setOf.set(x, si); }
          for (const b0 of c.bindings || []) {
            const b = deref(b0);
            if (!b || b.isEnabled === false) continue;
            const d = deref(b.destinationObject), sr = deref(b.sourceObject);
            if (!d || !sr || !b.destinationAttribute) continue;
            if (!binds.has(d)) binds.set(d, {});
            binds.get(d)[b.destinationAttribute] = { src: sr, attr: String(b.sourceAttribute || 'currentValue'), sc: +(b.scale ?? 1), off: arr(b.offset, [0, 0, 0, 0]) };
          }
        }
        for (const c of o.objects || []) collect(c);
      };
      collect(root);
      // 节点（每个外观一张图，跨文件共用序号）
      const nodeIx = new Map();
      const bindEntry = (b) => {
        if (b.src._type === 'EveChildInheritProperties') {
          const k = INHERIT.indexOf(b.attr.split('.')[0]);
          const v = k >= 0 ? arr(cs[k], [0, 0, 0, 0]) : [0, 0, 0, 0];
          const comp = b.attr.includes('.') ? b.attr.slice(b.attr.indexOf('.')) : '';
          return [N.push({ y: 'K', s: -1, v: v.map(f4) }) - 1, 'value' + comp, b.sc, b.off];
        }
        const i = nodeOf(b.src);
        return i == null ? null : [i, b.attr, b.sc, b.off];
      };
      const nodeOf = (o) => {
        if (nodeIx.has(o)) return nodeIx.get(o);
        let n;
        const s = setOf.has(o) ? setOf.get(o) : -1;
        switch (o._type) {
          case 'Tr2CurveScalar': n = { y: 'S', c: prepScalar(o), cv: +(o.currentValue ?? 0) }; break;
          case 'Tr2CurveColor': n = { y: 'C', ch: ['r', 'g', 'b', 'a'].map((k) => (deref(o[k]) ? prepScalar(deref(o[k])) : null)), to: +(o.timeOffset ?? 0), sg: o.srgbOutput ? 1 : 0, cv: arr(o.currentValue, [0, 0, 0, 1]) }; break;
          case 'Tr2CurveColorMixer': n = { y: 'M', c1: arr(o.color1, [0, 0, 0, 1]), c2: arr(o.color2, [0, 0, 0, 1]), l: +(o.lerpValue ?? 0), sa: +(o.saturation ?? 1), br: +(o.brightness ?? 1), ao: +(o.alphaOverride ?? -1), cv: arr(o.currentValue, [0, 0, 0, 1]) }; break;
          case 'Tr2CurveScalarExpression': n = { y: 'E', x: String(o.expression || ''), v: [1, 2, 3, 4].map((k) => +(o['input' + k] ?? 0)), ts: +(o.timeScale ?? 1), cv: +(o.currentValue ?? 0) }; break;
          case 'Tr2CurveVector3Expression': n = { y: 'V', xs: [o.expressionX, o.expressionY, o.expressionZ].map((x) => String(x || '')), v: [1, 2, 3, 4].map((k) => +(o['input' + k] ?? 0)), ts: +(o.timeScale ?? 1), cv: arr(o.currentValue, [0, 0, 0]) }; break;
          case 'Tr2CurveConstant': n = { y: 'K', v: arr(o.value, [0, 0, 0, 0]) }; break;
          default: unhandled[o._type] = (unhandled[o._type] || 0) + 1; nodeIx.set(o, null); return null;
        }
        n.s = s;
        const i = N.push(n) - 1;
        nodeIx.set(o, i);
        if (n.y === 'E' || n.y === 'V') n.in = (o.inputs || []).map((x) => { const d = deref(x); return d ? nodeOf(d) ?? -1 : -1; });
        const bd = binds.get(o);
        if (bd) { n.bd = {}; for (const [a, b] of Object.entries(bd)) { const e = bindEntry(b); if (e) n.bd[a] = e; } }
        return i;
      };
      const walk = (o, parent) => {
        o = deref(o);
        if (!o || typeof o !== 'object' || o.display === false) return;
        const m = mul(parent, local(o));
        const scale = /Mesh/.test(o._type || '') ? 1 : axisAvg(m);
        for (const L0 of o.lights || []) {
          const L = deref(L0);
          if (!L) continue;
          types[L._type] = (types[L._type] || 0) + 1;
          if (!/^Tr2(Point|Spot|Faction)Light$/.test(L._type || '')) continue;
          if (!(((L.flags ?? 1) & 1))) continue;
          let c0 = arr(L.color, [1, 1, 1, 1]).slice(0, 3);
          if (L._type === 'Tr2FactionLight') { const k = L.selectedColor ?? -1; if (k >= 0 && cs[k]) c0 = sat(arr(cs[k], [0, 0, 0]).slice(0, 3), +(L.saturation ?? 1)); }
          const br0 = +(L.brightness ?? 1), R0 = +(L.radius || 0), ri0 = +(L.innerRadius || 0);
          const b = {};
          const lb = binds.get(L) || {};
          for (const a of LIGHT_ATTRS) if (lb[a]) { const e = bindEntry(lb[a]); if (e) b[a] = e; }
          const spot = L._type === 'Tr2SpotLight' || (L._type === 'Tr2FactionLight' && L.isSpotlight) || Number(L.outerAngle) > 0;
          let dir = null;
          if (spot) { const d = xd(m, quatDir(L.rotation)); const n = Math.hypot(...d) || 1; dir = d.map((x) => f4(x / n)); }
          const outer = Number(L.outerAngle ?? 0), inner = Number(L.innerAngle ?? 0);
          lights.push({
            p: xp(m, arr(L.position, [0, 0, 0])).map(f4), dir,
            co: spot ? f4(Math.cos(outer * Math.PI / 180)) : 0, ci: spot ? f4(Math.cos(inner * Math.PI / 180)) : 0,
            na: f4(L.noiseAmplitude || 0), nf: f4(L.noiseFrequency || 0), no: L.noiseOctaves ?? 1,
            ies: String(L.lightProfilePath || '').toLowerCase() || null,
            a: { b, c0: c0.map(f4), br0: f4(br0), R0: f4(R0), ri0: f4(ri0), ps: f4(scale) },
          });
        }
        for (const c of o.objects || []) walk(c, m);
      };
      walk(root, srt({ translation: fj.t, rotation: fj.r, scaling: fj.s }));
    } catch (e) {
      process.stderr.write(`${key} ${fj.file}: ${e.message}\n`);
    }
  }
  // 求值：静态的烘成常量，动态的留绑定
  const G = createGraph({ sets, n: N });
  const valueOf = (a, t, seed) => {
    const ctx = G.make(t, seed);
    const pick = (name, def) => (a.b[name] ? ctx.pull(a.b[name]) : def);
    let c = pick('color', a.c0); c = typeof c === 'number' ? [c, c, c] : c.slice(0, 3);
    let br = pick('brightness', a.br0); if (typeof br !== 'number') br = br[0];
    let R = pick('radius', a.R0); if (typeof R !== 'number') R = R[0];
    let ri = pick('innerRadius', a.ri0); if (typeof ri !== 'number') ri = ri[0];
    return { c: c.map((x) => x * br), R: R * a.ps, ri: ri * a.ps };
  };
  for (const L of lights) {
    const a = L.a;
    stats.lights++;
    if (!Object.keys(a.b).length) { const v = valueOf(a, 0, 0); Object.assign(L, { c: v.c.map(f4), R: f4(v.R), ri: f4(v.ri), a: null }); stats.baked++; continue; }
    const vs = [];
    for (const seed of [0, 1]) for (const t of SAMPLE_T) vs.push(valueOf(a, t, seed));
    const same = vs.every((v) => Math.abs(v.R - vs[0].R) < 1e-5 && Math.abs(v.ri - vs[0].ri) < 1e-5 && v.c.every((x, i) => Math.abs(x - vs[0].c[i]) < 1e-5));
    if (same) { Object.assign(L, { c: vs[0].c.map(f4), R: f4(vs[0].R), ri: f4(vs[0].ri), a: null }); stats.baked++; continue; }
    // 动态：行里的半径取采样最大值（剔除用），颜色取各采样里最亮的一次（参考值）
    const top = vs.reduce((m, v) => (Math.max(...v.c) > Math.max(...m.c) ? v : m), vs[0]);
    Object.assign(L, { c: top.c.map(f4), R: f4(Math.max(...vs.map((v) => v.R))), ri: f4(vs[vs.length - 1].ri) });
    stats.anim++;
  }
  // 只留动态灯用到的节点
  const used = new Set();
  const mark = (i) => {
    if (i == null || i < 0 || used.has(i)) return; used.add(i);
    const n = N[i];
    for (const e of Object.values(n.bd || {})) mark(e[0]);
    for (const j of n.in || []) mark(j);
  };
  for (const L of lights) if (L.a) for (const e of Object.values(L.a.b)) mark(e[0]);
  let graph = null;
  if (used.size) {
    const order = [...used].sort((x, y) => x - y), re = new Map(order.map((o, i) => [o, i]));
    const remap = (e) => [re.get(e[0]), e[1], e[2], e[3]];
    const rnd = (v) => (Array.isArray(v) ? v.map(f4) : typeof v === 'number' ? f4(v) : v);
    const n2 = order.map((o) => {
      const n = { ...N[o] };
      if (n.bd) n.bd = Object.fromEntries(Object.entries(n.bd).map(([k, e]) => [k, remap(e)]));
      if (n.in) n.in = n.in.map((j) => (re.has(j) ? re.get(j) : -1));
      for (const k of ['cv', 'c1', 'c2', 'v']) if (k in n) n[k] = rnd(n[k]);
      if (n.c) n.c = { ...n.c, k: n.c.k.map((k) => k.map(f4)) };
      if (n.ch) n.ch = n.ch.map((c) => (c ? { ...c, k: c.k.map((k) => k.map(f4)) } : null));
      return n;
    });
    graph = { sets: sets.map(f4), n: n2 };
    for (const L of lights) if (L.a) L.a.b = Object.fromEntries(Object.entries(L.a.b).map(([k, e]) => [k, remap(e)]));
  }
  out[key] = { lights, graph, types, unhandled, stats };
}
process.stdout.write(JSON.stringify(out));
