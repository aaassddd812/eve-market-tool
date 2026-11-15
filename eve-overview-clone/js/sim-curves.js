// 客户端曲线 / 绑定的求值（carbon-trinity Curves/*），转换器（tools/ship-models/child-lights.mjs）和网页（sim-lights.js）共用，不依赖别的模块。
//   Tr2CurveScalar：键（时间、值、左右切线、插值 0 常量 / 1 线性 / 2 Hermite），前后外推 0 夹住 / 1 循环 / 2 镜像 / 3 线性，timeScale / timeOffset；
//     切线类型 AUTO_CLAMP（默认）/ AUTO 由 OnKeysChanged 重算（首尾键切线为 0），这里在 prepScalar 里照做。
//   Tr2CurveColor：r / g / b / a 四条标量曲线（a 空则 1），timeOffset，srgbOutput 时 pow(x, 1/2.2)。
//   Tr2CurveColorMixer：lerp(color1, color2) → 饱和度（0.299 / 0.587 / 0.114 亮度插值）→ × brightness，alphaOverride ≠ −1 时替换 a。
//   Tr2CurveScalarExpression：表达式（CcpParser；语法照 @carbonenginejs 的复刻：?: || && == != < <= > >= + - * / % ^ 一元 ! - +），
//     变量 time（= 时间 / timeScale）、input1..4，常量 pi、pi2，函数 fractal / noise（PerlinNoise1D）、randomConstant / randconst、random、randhash、input / inputAt、clamp 和常用数学函数。
//   TriCurveSet：播放中才每帧 UpdateValue 曲线、再 CopyValue 绑定（目标 = 源 × scale + offset）；playOnLoad 为 false 的不自动播。
//   这里按「拉取」求值：要某个属性时，它被绑定就去取源的当前值，曲线的当前值 = 它所在曲线集的时间（载入后秒数 × 曲线集 scale）处的值。

// ── PerlinNoise1D（TriMath：静态 TriPerlinNoise，种子 0）──
const PG = [-84,-209,-139,-64,67,-5,-61,103,-247,-45,21,-14,36,-169,-186,216,-168,140,58,-63,230,-217,-169,-82,-168,81,-91,-231,77,-184,9,148,-141,208,-13,-59,254,79,175,192,82,-157,216,-79,-13,29,-109,-109,142,167,32,193,9,-71,-129,-224,-225,-54,-12,-105,-93,254,203,114,-73,-228,34,-128,-128,164,-203,133,-218,232,-12,17,79,132,-151,-214,186,-225,120,1,65,231,169,-199,35,102,-137,11,174,-174,-165,128,142,-157,-203,140,-135,170,-172,-53,68,6,196,-209,-129,244,-125,204,100,-76,232,78,-113,-108,-29,186,23,-49,141,117,85,-208,49,-187,-87,-93,192,-161,-59,-162,0,113,-78,36,162,48,93,131,-158,-214,205,112,231,149,-55,127,-256,138,114,-213,186,127,-233,-69,-126,121,-158,-194,163,-34,-133,195,-174,174,-29,-108,-47,-206,155,14,-215,-198,-63,-220,10,-170,-213,104,-245,2,51,-176,-224,-74,-128,38,19,-82,-214,115,-72,188,232,-179,30,24,-131,2,-253,-162,-30,107,13,112,40,72,-237,-161,72,154,194,-8,-76,67,236,61,14,96,4,195,-19,-117,252,-170,205,121,-147,75,-72,-240,-104,157,-107,-146,-231,208,188,121,118,-139,189,-173,-95,104,160,-28,251,-5,-135,70,213,31].map((x) => x / 256);
function noise1(x) {
  const f = Math.floor(x), b0 = f & 255, b1 = (b0 + 1) & 255, rx = x - f;
  const v0 = rx * PG[b0], v1 = (rx - 1) * PG[b1];
  return v0 + rx * rx * (3 - 2 * rx) * (v1 - v0);
}
// PerlinNoise1D(x, invAmplitude, frequency, octaves) = FractalSum(x, octaves, 1 / invAmplitude, frequency)
export function perlin1D(x, invAmp = 2, freq = 2, oct = 1) {
  let sum = 0, sc = 1;
  for (let i = 0; i < oct; i++) { sum += noise1(x) * sc; sc /= invAmp; x *= freq; }
  return sum;
}

// ── Tr2CurveScalar ──
// 原始对象（.black 读出来的）→ { k: [[时间, 值, 左切线, 右切线, 插值]…], eb, ea, to, ts }
export function prepScalar(c) {
  const keys = (c?.keys || []).map((k) => ({ t: +k.time || 0, v: +k.value || 0, l: +k.leftTangent || 0, r: +k.rightTangent || 0, i: k.interpolation ?? 2, y: k.tangentType ?? 0 }));
  keys.sort((a, b) => a.t - b.t);
  const n = keys.length;
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    if (k.y === 0 || k.y === 1) {
      if (i === 0 || i === n - 1) { k.l = k.r = 0; continue; }
      const p = keys[i - 1], q = keys[i + 1];
      let tg;
      if (k.y === 0) {   // GetAutoClamppedTangent
        if ((k.v < p.v && k.v < q.v) || (k.v > p.v && k.v > q.v)) tg = 0;
        else {
          const vd = Math.abs(p.v - q.v);
          if (vd === 0) tg = 0;
          else { let kd = Math.abs(k.v - p.v) / vd; kd = Math.min(1, Math.min(kd, 1 - kd) * 6); tg = ((q.v - p.v) / (q.t - p.t)) * kd; }
        }
      } else {   // GetAutoTangent
        const left = k.t - p.t > 1e-6 ? (k.v - p.v) / (k.t - p.t) : 0, right = q.t - k.t > 1e-6 ? (q.v - k.v) / (q.t - k.t) : 0;
        const x = (k.t - p.t) / (q.t - p.t);
        tg = left * (1 - x) + right * x;
      }
      k.l = k.r = tg;
    } else if (k.y === 2) k.r = k.l;   // FREE_JOINED
  }
  return { k: keys.map((k) => [k.t, k.v, k.l, k.r, k.i]), eb: c?.extrapolationBefore ?? 0, ea: c?.extrapolationAfter ?? 0, to: +(c?.timeOffset ?? 0), ts: +(c?.timeScale ?? 1) || 1 };
}
function segment(t, a, b) {
  switch (a[4]) {
    case 0: return t === b[0] ? b[1] : a[1];
    case 1: return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    case 2: {
      const len = b[0] - a[0];
      if (len === 0) return b[1];
      const s = (t - a[0]) / len, s2 = s * s, s3 = s2 * s;
      const c2 = -2 * s3 + 3 * s2, c1 = 1 - c2, c4 = s3 - s2, c3 = s + c4 - s2;
      return a[1] * c1 + b[1] * c2 + a[3] * len * c3 + b[2] * len * c4;
    }
    default: return 0;
  }
}
export function scalarAt(c, time) {
  const K = c.k, n = K.length;
  if (!n) return 0;
  const t0 = time / c.ts - c.to;
  if (c.eb === 3 && t0 < K[0][0]) return K[0][1] - (K[0][0] - t0) * K[0][2];
  if (c.ea === 3 && t0 > K[n - 1][0]) return K[n - 1][1] + (t0 - K[n - 1][0]) * K[n - 1][3];
  if (n === 1) return K[0][1];
  if (c.eb === 0 && t0 <= K[0][0]) return K[0][1];
  if (c.ea === 0 && t0 >= K[n - 1][0]) return K[n - 1][1];
  // GetLocalTime
  const first = K[0][0], last = K[n - 1][0], len = last - first;
  let t = t0;
  if (len > 0 && t0 < first) {
    const q = -(t0 - first) / len, ip = Math.floor(q); let fp = q - ip;
    if (c.eb === 1) fp = 1 - fp; else if (ip % 2 !== 0) fp = 1 - fp;
    t = fp * len + first;
  } else if (len > 0 && t0 > last) {
    const q = (t0 - first) / len, ip = Math.floor(q); let fp = q - ip;
    if (c.ea === 2 && ip % 2 !== 0) fp = 1 - fp;
    t = fp * len + first;
  }
  for (let i = 0; i + 1 < n; i++) if (t >= K[i][0] && t < K[i + 1][0]) return segment(t, K[i], K[i + 1]);
  return segment(t, K[n - 2], K[n - 1]);
}

// ── 表达式 ──
const FN = {
  abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: (x) => Math.sqrt(Math.max(0, x)), pow: Math.pow,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, exp: Math.exp, log: Math.log, ln: Math.log, log2: Math.log2, log10: Math.log10, sign: Math.sign,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)), lerp: (a, b, t) => a + (b - a) * t, mod: (a, b) => (b === 0 ? 0 : a % b), radians: (x) => x * Math.PI / 180,
};
const CONST = { pi: 3.1415926, pi2: 2 * 3.1415926 };
const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '^', '!', '?', ':', '(', ')', ','];
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^(\d*\.?\d*(?:[eE][+-]?\d+)?)/.exec(s.slice(i)); if (!m[1] || m[1] === '.') throw new Error('数字'); out.push({ n: parseFloat(m[1]) }); i += m[1].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(s.slice(i)); out.push({ id: m[0] }); i += m[0].length; continue; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) throw new Error('字符 ' + c);
    out.push({ op }); i += op.length;
  }
  return out;
}
// 编译成闭包：(env) => 数值；env = { time, in: [input1..4], fn: { input, inputAt, rc } }
export function compileExpr(src) {
  const T = tokenize(String(src));
  let p = 0;
  const peek = (op) => T[p]?.op === op;
  const take = (op) => (peek(op) ? (p++, true) : false);
  const bin = (next, ops) => () => {
    let a = next();
    for (;;) {
      const op = ops.find((o) => peek(o));
      if (!op) return a;
      p++;
      const l = a, r = next();
      a = {
        '||': (e) => (l(e) || r(e) ? 1 : 0), '&&': (e) => (l(e) && r(e) ? 1 : 0), '==': (e) => (l(e) === r(e) ? 1 : 0), '!=': (e) => (l(e) !== r(e) ? 1 : 0),
        '<': (e) => (l(e) < r(e) ? 1 : 0), '<=': (e) => (l(e) <= r(e) ? 1 : 0), '>': (e) => (l(e) > r(e) ? 1 : 0), '>=': (e) => (l(e) >= r(e) ? 1 : 0),
        '+': (e) => l(e) + r(e), '-': (e) => l(e) - r(e), '*': (e) => l(e) * r(e), '/': (e) => { const d = r(e); return d === 0 ? 0 : l(e) / d; },
        '%': (e) => { const d = r(e); return d === 0 ? 0 : l(e) % d; }, '^': (e) => Math.pow(l(e), r(e)),
      }[op];
    }
  };
  let cond;
  const unary = () => {
    if (take('!')) { const a = unary(); return (e) => (a(e) ? 0 : 1); }
    if (take('-')) { const a = unary(); return (e) => -a(e); }
    if (take('+')) return unary();
    return primary();
  };
  const primary = () => {
    const t = T[p++];
    if (!t) throw new Error('意外结束');
    if (t.n != null) { const v = t.n; return () => v; }
    if (t.op === '(') { const a = cond(); if (!take(')')) throw new Error('缺 )'); return a; }
    if (t.id) {
      const name = t.id;
      if (take('(')) {
        const args = [];
        if (!take(')')) { do args.push(cond()); while (take(',')); if (!take(')')) throw new Error('缺 )'); }
        if (name === 'input') return (e) => e.fn.input(args[0](e));
        if (name === 'inputAt') return (e) => e.fn.inputAt(args[0](e), args[1](e));
        if (name === 'fractal') return (e) => (perlin1D(args[0](e) + e.fn.rc, args[1](e), args[2](e), Math.floor(args[3](e) + 0.5)) + 1) / 2;
        if (name === 'noise') return (e) => (perlin1D(args[0](e) + e.fn.rc, 1, 1, 1) + 1) / 2;
        if (name === 'randomConstant' || name === 'randconst') return (e) => { const a = args[0] ? args[0](e) : 0, b = args[1] ? args[1](e) : 1; return (b - a) * e.fn.rc + a; };
        if (name === 'random') return (e) => { const a = args[0] ? args[0](e) : 0, b = args[1] ? args[1](e) : 1; return (b - a) * Math.random() + a; };
        if (name === 'randhash') return (e) => { const a = args[0](e), b = args[1](e), x = args[2](e); const h = Math.sin(x * 12.9898 + e.fn.rc * 78.233) * 43758.5453; return a + (b - a) * (h - Math.floor(h)); };
        const f = FN[name];
        if (!f) throw new Error('函数 ' + name);
        return (e) => f(...args.map((a) => a(e)));
      }
      if (name in CONST) { const v = CONST[name]; return () => v; }
      if (name === 'time') return (e) => e.time;
      const m = /^input([1-4])$/.exec(name);
      if (m) { const i = +m[1] - 1; return (e) => e.in[i]; }
      throw new Error('变量 ' + name);
    }
    throw new Error('记号 ' + (t.op || ''));
  };
  const pow = bin(unary, ['^']);
  const mul = bin(pow, ['*', '/', '%']);
  const add = bin(mul, ['+', '-']);
  const cmp = bin(add, ['<=', '>=', '<', '>']);
  const eq = bin(cmp, ['==', '!=']);
  const and = bin(eq, ['&&']);
  const or = bin(and, ['||']);
  cond = () => { const c = or(); if (take('?')) { const a = cond(); if (!take(':')) throw new Error('缺 :'); const b = cond(); return (e) => (c(e) ? a(e) : b(e)); } return c; };
  const f = cond();
  if (p !== T.length) throw new Error('多余记号');
  return f;
}

// ── 绑定图求值 ──
// 图（转换器导出，模型 JSON 的 anim）：
//   sets: [曲线集 scale…]；n: 节点数组，每个 { y: 'S'|'C'|'M'|'E'|'K', s: 所在播放中曲线集序号（−1 = 不更新，当前值固定为 cv）, cv, bd: { 属性: [源节点, 源属性, scale, offset4] }, …类型字段 }
//     S：标量曲线（prepScalar 的结果放在 c）；C：ch = [r, g, b, a] 各为 prepScalar 结果或 null、to、sg（srgbOutput）；
//     M：c1、c2、l、sa、br、ao；E：x（表达式）、in（输入节点序号）、v（input1..4 的静态值）、ts；V：同 E，xs = [x, y, z] 三条表达式；K：v（常量）
const COMP = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
export function createGraph(G) {
  const N = G.n.map((n) => ({ ...n }));
  for (const n of N) {
    if (n.y === 'E') { try { n.f = compileExpr(n.x); } catch { n.f = null; } }
    if (n.y === 'V') n.fs = (n.xs || []).map((x) => { if (!x) return null; try { return compileExpr(x); } catch { return null; } });
  }
  // 一次求值的上下文：tInst = 载入后秒数，seed = 这个实例的随机种子（表达式 randomConstant）
  function make(tInst, seed) {
    const memo = new Map();
    const rcOf = (i) => { const h = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453; return h - Math.floor(h); };
    const apply = (v, sc, off) => (typeof v === 'number' ? v * sc + (off?.[0] || 0) : v.map((x, i) => x * sc + (off?.[i] || 0)));
    const pull = (b) => {
      let [src, attr, sc = 1, off] = b;
      let comp = -1;
      const dot = attr.lastIndexOf('.');
      if (dot > 0 && attr.slice(dot + 1) in COMP) { comp = COMP[attr.slice(dot + 1)]; attr = attr.slice(0, dot); }
      let v = get(src, attr);
      if (comp >= 0 && typeof v !== 'number') v = v[comp] ?? 0;
      return apply(v, sc, off);
    };
    const attrOf = (i, name, def) => { const n = N[i]; return n.bd?.[name] ? pull(n.bd[name]) : def; };
    function get(i, attr) {
      const n = N[i];
      if (!n) return 0;
      if (attr === 'currentValue' || attr === 'value' || n.y === 'K') return cur(i);
      if (n.y === 'M') return attrOf(i, attr, { color1: n.c1, color2: n.c2, lerpValue: n.l, saturation: n.sa, brightness: n.br }[attr] ?? 0);
      if (n.y === 'E' || n.y === 'V') { const m = /^input([1-4])$/.exec(attr); return attrOf(i, attr, m ? n.v[+m[1] - 1] : 0); }
      return 0;
    }
    function cur(i) {
      if (memo.has(i)) return memo.get(i);
      memo.set(i, N[i].cv ?? 0);   // 防环
      const n = N[i];
      const v = n.y === 'K' ? n.v : n.s < 0 ? (n.cv ?? 0) : at(i, tInst * (G.sets[n.s] ?? 1));
      memo.set(i, v);
      return v;
    }
    function at(i, time) {
      const n = N[i];
      switch (n.y) {
        case 'K': return n.v;
        case 'S': return scalarAt(n.c, time);
        case 'C': {
          const t = time - (n.to || 0);
          let c = [0, 1, 2, 3].map((k) => (n.ch[k] ? scalarAt(n.ch[k], t) : k === 3 ? 1 : 0));
          if (n.ch[3] && !n.ch[3].k.length) c[3] = 1;
          if (n.sg) c = c.map((x) => Math.pow(Math.max(0, x), 0.454545));
          return c;
        }
        case 'M': {
          const c1 = attrOf(i, 'color1', n.c1), c2 = attrOf(i, 'color2', n.c2), l = attrOf(i, 'lerpValue', n.l), sa = attrOf(i, 'saturation', n.sa), br = attrOf(i, 'brightness', n.br);
          let o = [0, 1, 2, 3].map((k) => (c1[k] ?? 1) + ((c2[k] ?? 1) - (c1[k] ?? 1)) * l);
          if (sa !== 1) { const g = o[0] * 0.299 + o[1] * 0.587 + o[2] * 0.114; o = o.map((x) => g + (x - g) * Math.max(0, sa)); }
          o = o.map((x) => x * br);
          if (n.ao !== -1 && n.ao != null) o[3] = Math.min(1, Math.max(0, n.ao));
          return o;
        }
        case 'V': {   // Tr2CurveVector3Expression：x / y / z 三条表达式，共用输入和随机常数
          const tt = time / (n.ts || 1);
          const env = { time: tt, in: [0, 1, 2, 3].map((k) => { const v = attrOf(i, 'input' + (k + 1), n.v[k]); return typeof v === 'number' ? v : v[0]; }),
            fn: { rc: rcOf(i), input: (k) => inAt(n, Math.floor(k + 0.5), tt), inputAt: (k, t2) => inAt(n, Math.floor(k + 0.5), t2) } };
          return [0, 1, 2].map((k) => (n.fs[k] ? n.fs[k](env) : 0));
        }
        case 'E': {
          if (!n.f) return 0;
          const tt = time / (n.ts || 1);
          const env = { time: tt, in: [0, 1, 2, 3].map((k) => { const v = attrOf(i, 'input' + (k + 1), n.v[k]); return typeof v === 'number' ? v : v[0]; }),
            fn: { rc: rcOf(i), input: (k) => inAt(n, Math.floor(k + 0.5), tt), inputAt: (k, t2) => inAt(n, Math.floor(k + 0.5), t2) } };
          return n.f(env);
        }
        default: return n.cv ?? 0;
      }
    }
    function inAt(n, k, time) { const j = n.in?.[k]; if (j == null || !N[j]) return 0; const v = at(j, time); return typeof v === 'number' ? v : v[0]; }
    return { pull, get };
  }
  return { make };
}
