// ===== 驾驶模拟：深渊空间的环境特效（three.js）=====
// 数据：tools/ship-models/fx-env.mjs 把客户端的特效文件转成 assets/eveui/fx/env/<名>.json（对象树原样）+ 网格 + 贴图：
//   边界泡   boundary_bubble.black（SDE 类型 47465）：sphere4k 网格（半径 0.01）× 7,500,000 = 半径 75 km
//   深渊云团 aoe_<种类>_<10k|30k|80k>_rt_01a.black（SDE 组 1971，见 CLOUD_FILE）
//   天气云层 cc_abyssal_<天气>_s3_01a.black；GPU 粒子共用的 fisfx/gpuparticles/system.black（图集 / 湍流噪声）
// 这里是只覆盖这些文件用到的部分的小运行时，照解析库（@carbonenginejs）对应类的实现和客户端着色器（effect.dx11 反汇编）重写：
//   曲线 Tr2CurveScalar / Tr2CurveScalarExpression（fractal / randconst / input）/ TriPerlinCurve / Tr2CurveEulerRotation，
//     曲线组 TriCurveSet（scale 缩放时间），绑定 TriValueBinding（目标 = 源 × scale + offset）；
//   节点 EveChild*（T·R·S，修饰器 TranslateWithCamera / Billboard2D，display 隐藏子树）；
//   CPU 粒子 Tr2ParticleSystem + Tr2DynamicEmitter（随机均匀 / 球壳生成器，死亡 / 生存期发射器）；
//   GPU 粒子 Tr2GpuUniqueEmitter（客户端在计算着色器里模拟，这里按 emit / update 着色器的算法在 CPU 上模拟，quads 着色器画）。
// 坐标：客户端是左手系，世界原点是自己的船（ego）。先在「客户端坐标（米，绝对）」里算完，渲染时减去 ego、沿 X 镜像、换成千米放进场景。
// 不做的：点光源对舰船的照明（Tr2PointLight）、雾体积（按无雾）、星云渗色（NEBULA_BLEEDING）、粒子排序。详见报告。
// 网格和贴图版权归 CCP。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOG_F = 'precision highp sampler3D;\n#include <common>\n#include <logdepthbuf_pars_fragment>\n';
// 客户端着色器结尾手动做的 线性 → sRGB（逆向确认：常数写死在着色器里，客户端不传运行时 gamma）；以及遮罩的 sRGB → 线性
const SRGB = `vec3 envEnc(vec3 c) { c = max(c, 0.0); return mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.003131)))); }
  float envDec(float v) { return v < 0.04045 ? v * 0.077399 : pow((v + 0.055) * 0.947867, 2.4); }`;

// SDE 类型 → 特效（graphicFile 的 .black 版）
export const CLOUD_FILE = {
  47439: 'bio10', 47440: 'bio30', 47441: 'bio80',              // 生物荧光云（作用半径 5 / 15 / 40 km）
  47436: 'caustic10', 47467: 'caustic30', 47468: 'caustic80',  // 腐蚀云
  47620: 'filament10', 47472: 'filament30', 47473: 'filament80', // 纤维云
};
export const BOUNDARY_R = 75000;   // 边界泡的实际半径（米）：网格半径 0.01 × 缩放 7,500,000
const WEATHERS = ['electricstorm', 'darkness', 'caustictoxin', 'xenongas', 'infernal'];

// ── 随机数与噪声（照 carbon：std::mt19937、TriPerlinNoise 的 256 个梯度、S 曲线插值）──
function mt19937(seed) {
  const N = 624, st = new Uint32Array(N);
  st[0] = seed >>> 0;
  for (let i = 1; i < N; i++) st[i] = (Math.imul(1812433253, st[i - 1] ^ (st[i - 1] >>> 30)) + i) >>> 0;
  let k = N;
  return () => {
    if (k >= N) {
      for (let i = 0; i < N; i++) {
        const y = (st[i] & 0x80000000) | (st[(i + 1) % N] & 0x7fffffff);
        st[i] = st[(i + 397) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      k = 0;
    }
    let y = st[k++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  };
}
// 全局固定种子 0 的一维 Perlin（PerlinNoise1D）
const GRAD = (() => { const r = mt19937(0); return Float64Array.from({ length: 256 }, () => ((r() % 512) - 256) / 256); })();
function perlin1(x) {
  const f = Math.floor(x), a = f & 255, b = (a + 1) & 255, x0 = x - f;
  const v0 = x0 * GRAD[a], v1 = (x0 - 1) * GRAD[b];
  return v0 + x0 * x0 * (3 - 2 * x0) * (v1 - v0);
}
// PerlinNoise1D(x, 反幅度, 频率, 层数)：每层幅度 × 1/反幅度、坐标 × 频率
function perlinFractal(x, invAmp, freq, oct) {
  let s = 0, sc = 1;
  const n = Number.isFinite(oct) ? Math.max(0, Math.trunc(oct)) : 0;
  for (let i = 0; i < n; i++) { s += perlin1(x) * sc; sc /= invAmp; x *= freq; }
  return s;
}
// TriPerlinCurve 的起点偏移：全局线性同余序列（初值 1234），× 32 位截断后的 10,000,000,000 ÷ 714025
let triRand = 1234;
function perlinStartOffset() {
  triRand = (((triRand << 12) + 150889) >>> 0) % 714025;
  return Math.floor((Math.imul(10000000000 >>> 0, triRand) >>> 0) / 714025);
}

// ── 曲线 ──
function wrapTime(t, first, last, before, after) {
  const len = last - first;
  if (len === 0) return first;
  if (t < first) {
    const q = (first - t) / len, n = Math.trunc(q);
    let f = q - n;
    if (before === 1 || n % 2 !== 0) f = 1 - f;
    return first + f * len;
  }
  if (t <= last) return t;
  const q = (t - first) / len, n = Math.trunc(q);
  let f = q - n;
  if (after === 2 && n % 2 !== 0) f = 1 - f;
  return first + f * len;
}
function scalarCurve(c, time) {
  const K = c.keys || [];
  if (!K.length) return c.value ?? 0;
  const t = time / (c.timeScale ?? 1) - (c.timeOffset ?? 0);
  const a0 = K[0], an = K[K.length - 1], eb = c.extrapolationBefore ?? 0, ea = c.extrapolationAfter ?? 0;
  if (eb === 3 && t < a0.time) return a0.value - (a0.time - t) * (a0.leftTangent ?? 0);
  if (ea === 3 && t > an.time) return an.value + (t - an.time) * (an.rightTangent ?? 0);
  if (K.length === 1) return a0.value;
  if (eb === 0 && t <= a0.time) return a0.value;
  if (ea === 0 && t >= an.time) return an.value;
  const lt = wrapTime(t, a0.time, an.time, eb, ea);
  let i = 0;
  while (i < K.length - 2 && lt >= K[i + 1].time) i++;
  const a = K[i], b = K[i + 1], len = b.time - a.time;
  switch (a.interpolation ?? 0) {
    case 0: return lt === b.time ? b.value : a.value;
    case 1: return len === 0 ? b.value : a.value + (b.value - a.value) * (lt - a.time) / len;
    default: {
      if (len === 0) return b.value;
      const s = (lt - a.time) / len, s2 = s * s, s3 = s2 * s;
      return a.value * (2 * s3 - 3 * s2 + 1) + (a.rightTangent ?? 0) * len * (s3 - 2 * s2 + s) + b.value * (3 * s2 - 2 * s3) + (b.leftTangent ?? 0) * len * (s3 - s2);
    }
  }
}
// 表达式：数字、time、函数调用、四则、比较、?:、括号
function compileExpr(src) {
  const tok = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|>=|<=|==|!=|&&|\|\||[-+*/(),?:<>!]/g) || [];
  let p = 0;
  const peek = () => tok[p];
  const need = (x) => { if (tok[p] !== x) throw new Error(`表达式 ${src}：缺 ${x}`); p++; };
  const prim = () => {
    const t = tok[p++];
    if (t === '(') { const e = cond(); need(')'); return e; }
    if (t === '-') { const e = prim(); return (c) => -e(c); }
    if (t === '!') { const e = prim(); return (c) => (e(c) ? 0 : 1); }
    if (/^[\d.]/.test(t)) { const v = +t; return () => v; }
    if (peek() === '(') {
      p++;
      const args = [];
      if (peek() !== ')') { args.push(cond()); while (peek() === ',') { p++; args.push(cond()); } }
      need(')');
      const f = EXPR_FN[t];
      if (!f) throw new Error(`表达式 ${src}：不认识 ${t}`);
      return (c) => f(c, ...args.map((x) => x(c)));
    }
    return (c) => c.vars[t] ?? 0;
  };
  const chain = (next, ops) => () => { let l = next(); while (ops[peek()]) { const op = ops[tok[p++]], r = next(), L = l; l = (c) => op(L(c), r(c)); } return l; };
  const mul = chain(prim, { '*': (a, b) => a * b, '/': (a, b) => a / b });
  const add = chain(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const cmp = chain(add, { '>': (a, b) => +(a > b), '<': (a, b) => +(a < b), '>=': (a, b) => +(a >= b), '<=': (a, b) => +(a <= b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const logic = chain(cmp, { '&&': (a, b) => +(a && b), '||': (a, b) => +(a || b) });
  const cond = () => { const c = logic(); if (peek() !== '?') return c; p++; const a = cond(); need(':'); const b = cond(); return (x) => (c(x) ? a(x) : b(x)); };
  return cond();
}
const EXPR_FN = {
  // 随机常数：每条表达式曲线一个 [0, 1) 的数
  randconst: (c, lo = 0, hi = 1) => lo + c.curve._rand * (hi - lo),
  randomConstant: (c, lo = 0, hi = 1) => lo + c.curve._rand * (hi - lo),
  random: (c, lo = 0, hi = 1) => lo + Math.random() * (hi - lo),
  noise: (c, x) => (perlinFractal(x + c.curve._rand, 1, 1, 1) + 1) / 2,
  fractal: (c, x, a, b, n) => (perlinFractal(x + c.curve._rand, a, b, Math.trunc(n + 0.5)) + 1) / 2,
  input: (c, i) => curveValue(c.curve.inputs?.[i | 0], c.time),
  inputAt: (c, i, t) => curveValue(c.curve.inputs?.[i | 0], t),
  sin: (c, x) => Math.sin(x), cos: (c, x) => Math.cos(x), abs: (c, x) => Math.abs(x), min: (c, a, b) => Math.min(a, b), max: (c, a, b) => Math.max(a, b),
  clamp: (c, x, a, b) => Math.min(b, Math.max(a, x)), lerp: (c, a, b, x) => a + (b - a) * x, pow: (c, a, b) => a ** b, sqrt: (c, x) => Math.sqrt(x),
};
// 欧拉角 → 四元数（XMQuaternionRotationRollPitchYaw 的顺序：yaw 绕 Y、pitch 绕 X、roll 绕 Z）
function yawPitchRoll(yaw, pitch, roll) {
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2), sr = Math.sin(roll / 2), cr = Math.cos(roll / 2);
  return [sy * cp * sr + cy * sp * cr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr];
}
function curveValue(c, time) {
  if (!c) return 0;
  switch (c._type) {
    case 'Tr2CurveScalar': return scalarCurve(c, time);
    case 'Tr2CurveScalarExpression': {
      if (!c._fn) { try { c._fn = c.expression ? compileExpr(c.expression) : () => 0; } catch (e) { console.warn(e.message); c._fn = () => 0; } }
      return Number(c._fn({ curve: c, time, vars: { time, input1: c.input1 ?? 0, input2: c.input2 ?? 0, input3: c.input3 ?? 0, input4: c.input4 ?? 0 } })) || 0;
    }
    case 'TriPerlinCurve': {
      c._start ??= perlinStartOffset();
      const n = perlinFractal((time + c._start) * (c.speed ?? 1), c.alpha ?? 1.1, c.beta ?? 2, c.n ?? 3);
      return (n + 1) / 2 * (c.scale ?? 1) + (c.offset ?? 0);
    }
    case 'Tr2CurveEulerRotation': return yawPitchRoll(curveValue(c.yaw, time), curveValue(c.pitch, time), curveValue(c.roll, time));
    default: return c.currentValue ?? c.value ?? 0;
  }
}
// 绑定：属性路径读写（value / value.x / rotation / brightness / display …）
const COMP = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
function applyBinding(b) {
  const src = b.sourceObject, dst = b.destinationObject;
  if (!src || !dst || !b.sourceAttribute || !b.destinationAttribute) return;
  const s = b.scale ?? 1, off = b.offset || [0, 0, 0, 0];
  const [sk, sc] = b.sourceAttribute.split('.');
  let v = src[sk] ?? 0;
  if (sc != null) v = Array.isArray(v) ? v[COMP[sc]] ?? 0 : 0;
  const [k, c] = b.destinationAttribute.split('.');
  if (c != null) {
    if (!Array.isArray(dst[k])) dst[k] = [0, 0, 0, 0];
    dst[k][COMP[c]] = (Array.isArray(v) ? v[0] : v) * s + off[COMP[c]];
  } else if (Array.isArray(v)) dst[k] = v.map((x, i) => x * s + (off[i] ?? 0));
  else if (Array.isArray(dst[k])) dst[k] = dst[k].map((_, i) => v * s + (off[i] ?? 0));
  else dst[k] = v * s + off[0];
}

// ── CPU 粒子（Tr2ParticleSystem / Tr2DynamicEmitter）──
// 元素类型：0 LIFETIME（归一化年龄、寿命秒数）、1 POSITION、2 VELOCITY、3 MASS、4 自定义
const EL_NAME = ['LIFE', 'POS', 'VEL', 'MASS'];
const EL_DIM = [2, 3, 3, 1];
class ParticleSystem {
  constructor(d) {
    this.max = d.maxParticleCount ?? 0;
    this.alive = 0;
    this.el = new Map();
    for (const e of d.elements || []) {
      const t = e.elementType ?? 4, name = t < 4 ? EL_NAME[t] : e.customName, dim = t < 4 ? EL_DIM[t] : e.dimension ?? 1;
      if (!this.el.has(name)) this.el.set(name, { dim, a: new Float32Array(Math.max(1, this.max) * dim), attr: null });
    }
    this.def = d;
    this.last = null;
    this.frame = -1;
  }
  spawn() {
    if (this.alive >= this.max) return -1;
    const i = this.alive++;
    for (const e of this.el.values()) e.a.fill(0, i * e.dim, (i + 1) * e.dim);
    return i;
  }
  remove(i) {
    const j = --this.alive;
    if (i !== j) for (const e of this.el.values()) e.a.copyWithin(i * e.dim, j * e.dim, (j + 1) * e.dim);
  }
  // Tr2ParticleSystem.Update：dt 夹到 1/3 秒；先老化（到 1 就死，先触发死亡发射器），再积分位置 + 生存期发射器（rate × dt）
  update(time, frame) {
    if (this.frame === frame) return;
    this.frame = frame;
    if (this.last === null) this.last = time;
    const dt = Math.max(0, Math.min(time - this.last, 1 / 3));
    this.last = time;
    const L = this.el.get('LIFE'), P = this.el.get('POS'), V = this.el.get('VEL');
    const death = this.def.emitParticleOnDeathEmitter, life = this.def.emitParticleDuringLifeEmitter;
    if (L && (this.def.applyAging ?? true)) {
      for (let i = 0; i < this.alive; i++) {
        L.a[i * 2] += dt / L.a[i * 2 + 1];
        if (L.a[i * 2] >= 1) {
          if (death) emitterSpawn(death, P && P.a.subarray(i * 3, i * 3 + 3), V && V.a.subarray(i * 3, i * 3 + 3), 1);
          this.remove(i--);
        }
      }
    }
    if ((this.def.updateSimulation ?? true) && P && V) {
      const n = this.alive;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) P.a[i * 3 + k] += V.a[i * 3 + k] * dt;
        if (life) emitterSpawn(life, P.a.subarray(i * 3, i * 3 + 3), V.a.subarray(i * 3, i * 3 + 3), dt);
      }
    } else if (life) {
      for (let i = 0; i < this.alive; i++) emitterSpawn(life, P && P.a.subarray(i * 3, i * 3 + 3), V && V.a.subarray(i * 3, i * 3 + 3), dt);
    }
  }
}
// 生成器（Tr2RandomUniformAttributeGenerator / Tr2SphereShapeAttributeGenerator），位置都是粒子系统的局部坐标
function generate(g, sys, i, pPos, pVel) {
  if (g._type === 'Tr2RandomUniformAttributeGenerator') {
    const t = g.elementType ?? 4, e = sys.el.get(t < 4 ? EL_NAME[t] : g.customName);
    if (!e) return;
    const lo = g.minRange || [0, 0, 0, 0], hi = g.maxRange || [0, 0, 0, 0];
    for (let k = 0; k < e.dim; k++) e.a[i * e.dim + k] = (lo[k] ?? 0) + Math.random() * ((hi[k] ?? 0) - (lo[k] ?? 0));
  } else if (g._type === 'Tr2SphereShapeAttributeGenerator') {
    const phi = ((g.minPhi ?? 0) + Math.random() * ((g.maxPhi ?? 360) - (g.minPhi ?? 0))) * Math.PI / 180;
    const th = ((g.minTheta ?? 0) + Math.random() * ((g.maxTheta ?? 360) - (g.minTheta ?? 0))) * Math.PI / 180;
    const d = new THREE.Vector3(Math.sin(phi) * Math.cos(th), -Math.cos(phi), Math.sin(phi) * Math.sin(th));
    const q = g.rotation || [0, 0, 0, 1];
    d.applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
    const V = (g.controlVelocity ?? true) ? sys.el.get('VEL') : null, P = (g.controlPosition ?? true) ? sys.el.get('POS') : null;
    if (V) {
      const sp = (g.minSpeed ?? 0) + Math.random() * ((g.maxSpeed ?? 0) - (g.minSpeed ?? 0)), f = g.parentVelocityFactor ?? 1;
      for (let k = 0; k < 3; k++) V.a[i * 3 + k] = d.getComponent(k) * sp + (pVel?.[k] ?? 0) * f;
    }
    if (P) {
      const r = (g.minRadius ?? 0) + ((g.maxRadius ?? 0) - (g.minRadius ?? 0)) * Math.pow(Math.random(), g.distributionExponent ?? 1);
      const o = g.position || [0, 0, 0];
      for (let k = 0; k < 3; k++) P.a[i * 3 + k] = d.getComponent(k) * r + o[k] + (pPos?.[k] ?? 0);
    }
  }
}
// Tr2DynamicEmitter.SpawnParticles：rate × 系数 累积，取整个数发出；系统满了就停
function emitterSpawn(em, pPos, pVel, k) {
  const sys = em.particleSystem?._rt;
  if (!sys || !(em.rate > 0)) return;
  em._acc = (em._acc || 0) + em.rate * Math.max(0, k);
  let n = Math.floor(em._acc);
  em._acc -= n;
  if ((em.maxParticles ?? -1) >= 0) { n = Math.max(0, Math.min(n, em.maxParticles - (em._emitted || 0))); em._emitted = (em._emitted || 0) + n; }
  for (let j = 0; j < n; j++) {
    const i = sys.spawn();
    if (i < 0) break;
    for (const g of em.generators || []) generate(g, sys, i, pPos, pVel);
  }
}
// Tr2DynamicEmitter.Update：dt 夹到 0.3 秒，第一次 dt = 0
function emitterUpdate(em, time) {
  if (em._last == null) em._last = time;
  const dt = Math.min(time - em._last, 0.3);
  em._last = time;
  emitterSpawn(em, null, null, Math.max(0, dt));
}

// ── 体积噪声（GPU 粒子湍流用的 noise32cube_volume，CPU 上三线性、重复寻址）──
function sampleVol(v, x, y, z, out) {
  const { w, h, d, c, data } = v;
  const fx = x * w - 0.5, fy = y * h - 0.5, fz = z * d - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz), tx = fx - x0, ty = fy - y0, tz = fz - z0;
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
    const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
    const xi = ((x0 + dx) % w + w) % w, yi = ((y0 + dy) % h + h) % h, zi = ((z0 + dz) % d + d) % d;
    const o = ((zi * h + yi) * w + xi) * c;
    for (let j = 0; j < 3; j++) out[j] += wgt * data[o + Math.min(j, c - 1)] / 255;
  }
  return out;
}

// ── 着色器 ──
// 公用：uW = 节点在「客户端坐标、相对 ego」里的世界矩阵（米）；uCam = 镜头在同一坐标里的位置；uTime = 着色器时间（cb2[21].x）
// 场景里 modelViewMatrix 的单位是千米，换成米 ×1000
const BB_VS = `${LOG_V} uniform mat4 uW; uniform vec3 uCam; uniform vec4 LayerParams;
  varying vec3 vP, vN, vWP, vNW, vV; varying float vZ;
  void main() {
    vec4 wp = uW * vec4(position, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vP = position; vN = normal; vWP = wp.xyz; vNW = normalize(mat3(uW) * normal); vV = uCam - wp.xyz; vZ = mv.z * 1000.0;
    // 顶点离原点（ego）超过 5 × LayerParams.y 的退化掉（VS 里乘 0）
    gl_Position = projectionMatrix * mv * (length(wp.xyz) <= 5.0 * LayerParams.y ? 1.0 : 0.0);
    #include <logdepthbuf_vertex>
  }`;
const SHADERS = {
  // spaceobject/fx/bubble/boundarybubble.fx：三向投影遮罩（只取 alpha）→ 线性；离 ego 越远越淡；视深淡入；反菲涅尔；pass ONE / INVSRCCOLOR、不剔除
  bb: {
    vs: BB_VS,
    fs: `${LOG_F} uniform sampler2D MaskMap; uniform vec4 XYScroll, YZScroll, XZScroll, LayerOffsets, LayerParams, BrightnessParams, Color, Fresnel; uniform float uTime;
    varying vec3 vP, vN, vWP, vNW, vV; varying float vZ; ${SRGB}
    void main() {
      #include <logdepthbuf_fragment>
      vec4 o = LayerOffsets, s;
      s = fract(XYScroll * uTime) + vP.xyxy * LayerParams.x;
      float xy = sqrt(max(texture2D(MaskMap, s.xy + o.yx).a, texture2D(MaskMap, s.zw + o.zx).a));
      s = fract(YZScroll * uTime) + vP.yzyz * LayerParams.x;
      float yz = sqrt(max(texture2D(MaskMap, s.xy + o.xy).a, texture2D(MaskMap, s.zw + o.yz).a));
      s = fract(XZScroll * uTime) + vP.xzxz * LayerParams.x;
      float xz = sqrt(max(texture2D(MaskMap, s.xy + o.yx).a, texture2D(MaskMap, s.zw + o.zy).a));
      vec3 n = normalize(vN); n *= n;
      float m = envDec(xz * n.y + yz * n.x + xy * n.z);
      float sb = clamp(BrightnessParams.y, 0.0, 1.0), d = length(vWP);
      m = m / sb * sb * (1.0 - pow(clamp(d / LayerParams.y, 0.0, 1.0), LayerParams.z)) * (5.0 * LayerParams.y >= d ? 1.0 : 0.0);
      m *= BrightnessParams.y * clamp(-vZ / LayerParams.w, 0.0, 1.0);
      // 正反面的法线翻转：取朝向观察者的一面（|N·V|）
      m *= 1.0 - Fresnel.x * pow(clamp(1.0 - abs(dot(normalize(vNW), normalize(vV))), 0.0, 1.0), Fresnel.z);
      vec4 c = clamp(m * Color, 0.0, 1.0);
      gl_FragColor = vec4(envEnc(c.rgb), c.a);
    }`,
  },
  // spaceobject/fx/bubble/aoebubble.fx：两层三向投影（R、A 两通道相乘开方）+ 细节层（G），近处显示遮罩（A）、远处显示细节；pass ONE / INVSRCCOLOR、不剔除
  aoe: {
    vs: `${LOG_V} varying vec3 vP, vN; varying float vZ;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vP = position; vN = normal; vZ = mv.z * 1000.0;
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D MaskMap; uniform vec4 XYScroll, YZScroll, XZScroll, LayerOffsets, LayerParams, BrightnessParams, Color; uniform float uTime;
    varying vec3 vP, vN; varying float vZ; ${SRGB}
    void main() {
      #include <logdepthbuf_fragment>
      float k = pow(max(-vZ / LayerParams.y, 0.0), LayerParams.z);
      if (k > 1.0) discard;
      vec4 o = LayerOffsets, s;
      s = fract(YZScroll * uTime) + vP.yzyz * LayerParams.x;
      vec2 yz = texture2D(MaskMap, s.xy + o.xy).ra * texture2D(MaskMap, s.zw + o.yz).ra;
      s = fract(XZScroll * uTime) + vP.xzxz * LayerParams.x;
      vec2 xz = texture2D(MaskMap, s.xy + o.yx).ra * texture2D(MaskMap, s.zw + o.zy).ra;
      s = fract(XYScroll * uTime) + vP.xyxy * LayerParams.x;
      vec2 xy = texture2D(MaskMap, s.xy + o.yx).ra * texture2D(MaskMap, s.zw + o.zx).ra;
      vec3 n = normalize(vN); n *= n;
      vec2 ra = sqrt(yz) * n.x + sqrt(xz) * n.y + sqrt(xy) * n.z;
      float a = envDec(ra.y);
      float g = texture2D(MaskMap, vP.yz * BrightnessParams.x + 0.3).g * n.x + texture2D(MaskMap, vP.xz * BrightnessParams.x + 0.12).g * n.y + texture2D(MaskMap, vP.xy * BrightnessParams.x + 0.7).g * n.z;
      float v = mix(a, g * ra.x * (gl_FrontFacing ? 1.0 : BrightnessParams.z), k) * BrightnessParams.y * clamp(-vZ / LayerParams.w, 0.0, 1.0);
      vec4 c = clamp(v * Color, 0.0, 1.0);
      gl_FragColor = vec4(envEnc(c.rgb), c.a);
    }`,
  },
  // specialfx/environment/cloudcover.fx：局部位置投影成两张云图（按 |y| 缩放），扭曲 + 四层滚动，查颜色渐变；地平线压暗；可选闪电（LIGHTNING_ENABLED）
  cc: {
    vs: `${LOG_V} varying vec3 vP;
    void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D CloudMap, ColorRampMap, LightingMap; uniform sampler3D LightingWavesMap;
    uniform vec4 ShapeParams, GeneralParams, CloudParams, HorizonParams, LightingTiling, LightingParams, LightingColor; uniform float uTime;
    varying vec3 vP; ${SRGB}
    void main() {
      #include <logdepthbuf_fragment>
      float ay = abs(vP.y);
      vec2 uv = vP.xz / pow(ay, ShapeParams.x);
      if (vP.y < 0.0) uv = uv.yx + 0.3;
      vec2 uv0 = uv;
      uv += texture2D(CloudMap, uv).rg * pow(abs(1.0 - ay), ShapeParams.z) * ShapeParams.y;
      uv *= CloudParams.x;
      float tf = CloudParams.y * uTime;
      float c = sqrt(texture2D(CloudMap, uv * 2.0 + tf * vec2(0.495828, -0.064458)).r * texture2D(CloudMap, uv * 2.0 + tf * vec2(-0.496942, 0.055216)).r) * 0.5
              + sqrt(texture2D(CloudMap, uv + tf * vec2(0.991656, -0.128915)).r * texture2D(CloudMap, uv + tf * vec2(-0.993884, 0.110432)).r);
      vec4 ramp = textureLod(ColorRampMap, vec2(c * CloudParams.z * 0.666667, ay * HorizonParams.w), 0.0);
      float h = pow(clamp(ay * HorizonParams.x, 0.0, 1.0), HorizonParams.y);
      #ifdef LIGHTNING
        float lm = texture2D(LightingMap, uv0 * LightingTiling.z).r;
        float wv = texture(LightingWavesMap, vec3(uv0.x * LightingTiling.x + uTime * LightingParams.w, uv0.y * LightingTiling.y, LightingTiling.w * uTime)).r;
        float v = max(abs((lm + wv) * LightingParams.x), 0.01);
        vec3 L = pow(max(1.0 / v - 1.0 / LightingParams.y, 0.0), LightingParams.z) * LightingColor.rgb;
        vec3 rgb = (L * ramp.a + ramp.rgb * CloudParams.w) * h;
      #else
        vec3 rgb = h * ramp.rgb * CloudParams.w;
      #endif
      vec4 o = vec4(rgb, (1.0 + HorizonParams.z * (h - 1.0)) * ramp.a) * GeneralParams.x;
      gl_FragColor = vec4(envEnc(o.rgb), o.a);
    }`,
  },
  // specialfx/ubershader.fx 默认分支（和 sim-cfx.js 的 uber 同一份分析）：两张滚动贴图 × 遮罩 × 颜色 × 菲涅尔
  uber: {
    vs: `${LOG_V} varying vec2 vUv; varying vec3 vN, vV;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vUv = uv; vN = mat3(modelMatrix) * normal; vV = cameraPosition - wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D DiffuseMap1, DiffuseMap2, MaskMap; uniform vec4 DiffuseColor, TextureScroll1, TextureScroll2, TextureTransform1, TextureTransform2, FresnelFactors; uniform float uTime;
    varying vec2 vUv; varying vec3 vN, vV;
    void main() {
      #include <logdepthbuf_fragment>
      vec4 a = texture2D(DiffuseMap1, vUv * TextureTransform1.zw + TextureTransform1.xy + TextureScroll1.xy * uTime + TextureScroll1.zw);
      if (dot(a, a) == 0.0) discard;
      vec4 b = texture2D(DiffuseMap2, vUv * TextureTransform2.zw + TextureTransform2.xy + TextureScroll2.xy * uTime + TextureScroll2.zw);
      if (dot(b, b) == 0.0) discard;
      vec4 m = texture2D(MaskMap, vUv);
      if (dot(m, m) == 0.0) discard;
      vec4 c = a * b * m * DiffuseColor;
      vec4 F = FresnelFactors;
      float x = pow(1.0 - clamp(dot(normalize(vV), normalize(vN)) - F.z, 0.0, 1.0), F.x);
      c.rgb *= F.y < 0.0 ? (1.0 - min(x, 1.0)) * -F.y : x * F.y;
      gl_FragColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
    }`,
  },
  // specialfx/lensflares/flare.fx：按到中心的距离查渐变；不剔除
  flare: {
    vs: `${LOG_V} varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D GradientMap; uniform vec4 DiffuseColor, Brightness; varying vec2 vUv;
    void main() {
      #include <logdepthbuf_fragment>
      float r = length((vUv - 0.5) * 2.0);
      gl_FragColor = texture2D(GradientMap, vec2(r, r)) * DiffuseColor * Brightness.x;
    }`,
  },
  // specialfx/flarequadsoft.fx（EveChildQuad）：中心放进 view 空间，角点按局部矩阵 × 父矩阵平均缩放展开；越偏离视线中心越暗
  fq: {
    vs: `${LOG_V} uniform vec3 uCenter; uniform vec4 uAxes; uniform float uScale; uniform vec4 uColor; varying vec2 vUv; varying vec3 vCol;
    void main() {
      vec4 mv = modelViewMatrix * vec4(uCenter, 1.0);
      float k = asin(clamp(-mv.z / length(mv.xyz), 0.0, 1.0)) / 1.570796;
      vCol = uColor.rgb * k * k;
      vec2 c = position.xy;
      mv.xy += vec2(c.x * uAxes.x + c.y * uAxes.z, c.x * uAxes.y + c.y * uAxes.w) * uScale * 0.001;
      vUv = uv;
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} varying vec2 vUv; varying vec3 vCol;
    void main() {
      #include <logdepthbuf_fragment>
      float r = min(length(vUv * 2.0 - 1.0), 1.0);
      gl_FragColor = vec4(vCol * (1.0 / sqrt(r + 0.1) - 0.953463), 0.0);
    }`,
  },
  // specialfx/particles/2layermask.fx（PARTICLE_STATIC、NEAR_FADE_ENABLED、TEXTURE_OFFSETS_ENABLED）
  p2l: {
    vs: `${LOG_V} attribute vec3 iPos; attribute vec2 iSize; attribute float iSpin; attribute vec4 iOffset;
    uniform float uWS, uTime; uniform vec4 SpriteFactors, Layer1TexCoordModifier, Layer2TexCoordModifier, Color1, Color2, Color3, ColorMidpoint, UseWorldScale, Layer1TexCoordSpeed, Layer2TexCoordSpeed;
    varying vec4 vUv12, vCol; varying vec2 vUv; varying float vZ;
    void main() {
      float s = UseWorldScale.x > 0.0 ? uWS * iSize.x : iSize.x;
      vec2 c = position.xy * s;
      float a = iSpin + SpriteFactors.y, sa = sin(a), ca = cos(a);
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      mv.xy += vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y) * 0.001;
      gl_Position = projectionMatrix * mv;
      vZ = mv.z * 1000.0;
      vUv12 = vec4(Layer1TexCoordModifier.xy * uv + uTime * Layer1TexCoordSpeed.xy + Layer1TexCoordModifier.zw + iOffset.xy,
                   Layer2TexCoordModifier.xy * uv + uTime * Layer2TexCoordSpeed.xy + Layer2TexCoordModifier.zw + iOffset.zw);
      float mid = ColorMidpoint.x;
      vCol = mid >= 0.0 ? Color1 : mix(Color2, Color3, clamp(-mid / (1.0 - mid), 0.0, 1.0));
      vUv = uv;
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D TexMapLayer1, TexMapLayer2, MaskMap; uniform vec4 SpriteColor, SpriteFactors, ParticleParams, Brightness;
    varying vec4 vUv12, vCol; varying vec2 vUv; varying float vZ;
    void main() {
      #include <logdepthbuf_fragment>
      vec4 m = texture2D(MaskMap, vUv);
      if (m.a <= 0.0) discard;
      vec4 c = m * texture2D(TexMapLayer1, vUv12.xy) * texture2D(TexMapLayer2, vUv12.zw);
      c *= clamp((abs(vZ) - ParticleParams.x) / (ParticleParams.y - ParticleParams.x), 0.0, 1.0);
      float A = vCol.a * SpriteColor.a;
      vec3 rgb = c.rgb * (SpriteFactors.x * (A * c.a - 1.0) + 1.0) * vCol.rgb * SpriteColor.rgb;
      gl_FragColor = vec4(rgb, c.a * A * SpriteFactors.z) * Brightness.x;
    }`,
  },
  // specialfx/particles/motionvector.fx（PARTICLE_STATIC、NEAR_FADE_ALPHA、COLOR_RAMP_ENABLED）：序列帧图集 + 运动向量插帧，按亮度查颜色渐变
  pmv: {
    vs: `${LOG_V} attribute vec3 iPos; attribute vec2 iSize; attribute float iSpin; attribute vec4 iColor0;
    uniform float uWS, uTime; uniform vec4 SpriteFactors, UseWorldScale, AtlasInfo;
    varying vec4 vA, vCol;
    void main() {
      float s = UseWorldScale.x > 0.0 ? uWS * iSize.x : iSize.x;
      vec2 c = position.xy * s;
      float a = iSpin + SpriteFactors.y, sa = sin(a), ca = cos(a);
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      mv.xy += vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y) * 0.001;
      gl_Position = projectionMatrix * mv;
      vA = vec4(uv, uTime / AtlasInfo.z + iSpin, mv.z * 1000.0);
      vCol = iColor0;
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D TextureMap, ColorRampMap, GradientMap; uniform vec4 AtlasInfo, Colors, ParticleParams, Colors2;
    varying vec4 vA, vCol; ${SRGB}
    vec2 cell(float f) { float row = min(AtlasInfo.y - 1.0, floor(f / AtlasInfo.x)); return vec2(min(AtlasInfo.x - 1.0, floor(f - row * AtlasInfo.x)), row); }
    void main() {
      #include <logdepthbuf_fragment>
      float N = AtlasInfo.x * AtlasInfo.y, x = vA.z * AtlasInfo.z, y = fract(x / AtlasInfo.z) * N;
      float f0 = floor(y), bl = fract(y), f1;
      if (AtlasInfo.w > 0.0) f1 = f0 + 1.0 >= N ? 0.0 : f0 + 1.0; else f1 = min(N - 1.0, f0 + 1.0);
      if (AtlasInfo.w <= 0.0 && x >= AtlasInfo.z) { f0 = N - 1.0; f1 = N - 1.0; }
      vec2 c0 = cell(f0), c1 = cell(f1), uv = clamp(vA.xy, 0.0, 1.0);
      vec2 m0 = vec2(0.0), m1 = vec2(0.0);
      if (Colors.w > 0.0) {
        m0 = (texture2D(GradientMap, (uv + c0) / AtlasInfo.xy).xy * 2.0 - 1.0) * bl * Colors.w;
        m1 = (texture2D(GradientMap, (uv + c1) / AtlasInfo.xy).xy * 2.0 - 1.0) * (1.0 - bl) * Colors.w;
      }
      vec2 A = texture2D(TextureMap, (clamp(vA.xy - m0, 0.0, 1.0) + c0) / AtlasInfo.xy).ra;
      vec2 B = texture2D(TextureMap, (clamp(vA.xy + m1, 0.0, 1.0) + c1) / AtlasInfo.xy).ra;
      vec2 r = mix(A, B, bl);
      if (r.y <= 0.0) discard;
      vec4 ramp = textureLod(ColorRampMap, vec2(clamp((r.x - Colors.x) / (Colors.y - Colors.x), 0.0, 1.0), vA.z), 0.0);
      ramp.a *= r.y;
      vec4 o = ramp * vCol;
      float a = o.a * Colors2.w * clamp((abs(vA.w) - ParticleParams.x) / (ParticleParams.y - ParticleParams.x), 0.0, 1.0);
      gl_FragColor = vec4(envEnc(o.rgb * Colors.z), a);
    }`,
  },
  // specialfx/particles/dynamic/1layerdynv2.fx（默认排列）：按年龄插值尺寸 / 颜色，旋转 = 年龄 × 角速度 × 寿命 + 初始角，N×N 图集选格；距离缩放用默认参数
  pdyn: {
    vs: `${LOG_V} attribute vec3 iPos; attribute vec2 iLife, iSize; attribute float iSpin, iSpinVel, iAtlas;
    uniform float uWS; uniform vec4 SpriteFactors, Layer1TexCoordModifier, Color1, Color2, Color3, ColorMidpoint, UseWorldScale, DistanceScalingParams;
    varying vec4 vCol; varying vec2 vUv; varying vec3 vAt; varying float vW;
    void main() {
      float age = iLife.x, s = mix(iSize.x, iSize.y, age);
      if (UseWorldScale.x > 0.0) s *= uWS;
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      vW = -mv.z * 1000.0;
      vec4 D = DistanceScalingParams;
      s *= clamp((vW - D.x) / (D.y - D.x), 0.0, 1.0) * (D.w - D.z) + D.z;
      vec2 c = position.xy * s;
      float a = age * iSpinVel * iLife.y + iSpin + SpriteFactors.y, sa = sin(a), ca = cos(a);
      mv.xy += vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y) * 0.001;
      gl_Position = projectionMatrix * mv;
      float mid = ColorMidpoint.x;
      vCol = age <= mid ? mix(Color1, Color2, clamp(age / mid, 0.0, 1.0)) : mix(Color2, Color3, clamp((age - mid) / (1.0 - mid), 0.0, 1.0));
      vUv = Layer1TexCoordModifier.xy * uv + Layer1TexCoordModifier.zw;
      float n = SpriteFactors.w, q = trunc(iAtlas) / n, qi = trunc(q);
      vAt = vec3(q - qi, qi / n, 1.0 / n);
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D TexMapLayer1; uniform vec4 SpriteColor, SpriteFactors, ParticleParams;
    varying vec4 vCol; varying vec2 vUv; varying vec3 vAt; varying float vW;
    void main() {
      #include <logdepthbuf_fragment>
      vec2 g = vUv * vAt.z;
      vec4 t = textureGrad(TexMapLayer1, fract(vUv) * vAt.z + vAt.xy, dFdx(g), dFdy(g));
      float A = vCol.a * SpriteColor.a;
      vec3 rgb = t.rgb * vCol.rgb * SpriteColor.rgb * (SpriteFactors.x * (A * t.a - 1.0) + 1.0);
      gl_FragColor = vec4(rgb, t.a * A * SpriteFactors.z) * clamp((vW - ParticleParams.x) / (ParticleParams.y - ParticleParams.x), 0.0, 1.0);
    }`,
  },
  // specialfx/particles/gpu/quads.fx：GPU 粒子（这里在 CPU 上模拟，位置已经是相对 ego 的客户端坐标）
  gpu: {
    vs: `${LOG_V} attribute vec3 iPos, iVel; attribute vec3 iAge;
    uniform vec4 uC0, uC1, uC2, uC3, uSizes, uMisc; uniform vec2 uView;
    varying vec4 vCol; varying vec2 vUv;
    void main() {
      float t = clamp(iAge.x / iAge.y, 0.0, 1.0), it = 1.0 - t, hi = iAge.z;
      float s = (it * it * uSizes.x + 2.0 * t * it * uSizes.y + t * t * uSizes.z) * (1.0 + uSizes.w * hi), h = s * 0.25;
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      vec2 c = position.xy * 2.0, off;
      float k = 1.0, vsr = uMisc.y;
      if (vsr < 0.0) {
        // 沿屏幕上的运动方向拉长：尾部两个顶点往回拉 d，亮度 × (s/2) / (|d| + s/2)
        vec4 mv2 = modelViewMatrix * vec4(iPos + iVel * vsr, 1.0);
        vec2 d = (mv.xy - mv2.xy) * 1000.0;
        float l = length(d);
        vec2 ax = l > 0.0 ? d / l : vec2(1.0, 0.0), ay = vec2(-ax.y, ax.x);
        off = (ax * c.x + ay * c.y) * h + (c.x < 0.0 ? -d : vec2(0.0));
        k = s * 0.5 / (l + s * 0.5);
      } else {
        float h16 = floor(hi * 65535.0);
        float a = vsr * iAge.x * (fract(h16 * 0.000153) > 0.5 ? 1.0 : -1.0) + h16 * 0.000096, sa = sin(a), ca = cos(a);
        off = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y) * h;
      }
      mv.xy += off * 0.001;
      gl_Position = projectionMatrix * mv;
      float w = max(-mv.z * 1000.0, 1e-3);
      k *= clamp(0.5 * min(h / w * uView.x, h / w * uView.y), 0.0, 1.0);
      vUv = (c * 0.5 + 0.5) / vec2(8.0, 1.0) + vec2(floor(uMisc.x) / 8.0, 0.0);
      float tp = pow(t, -log2(fract(uMisc.x)));
      vec4 col = tp < 0.333 ? mix(uC0, uC1, tp * 3.003) : tp < 0.666 ? mix(uC1, uC2, tp * 3.003 - 1.0) : mix(uC2, uC3, tp * 2.994 - 1.994);
      col.a *= k;
      vCol = vec4(col.rgb * col.a, col.a);
      #include <logdepthbuf_vertex>
    }`,
    fs: `${LOG_F} uniform sampler2D AtlasMap; varying vec4 vCol; varying vec2 vUv; ${SRGB}
    void main() {
      #include <logdepthbuf_fragment>
      vec4 c = texture2D(AtlasMap, vUv) * vCol;
      gl_FragColor = vec4(envEnc(c.rgb), c.a);
    }`,
  },
};
// 着色器文件 → 上面的实现
const SHADER_OF = {
  'boundarybubble.fx': 'bb', 'aoebubble.fx': 'aoe', 'cloudcover.fx': 'cc', 'ubershader.fx': 'uber', 'flare.fx': 'flare',
  '2layermask.fx': 'p2l', 'motionvector.fx': 'pmv', '1layerdynv2.fx': 'pdyn', 'flarequadsoft.fx': 'fq',
};
// 常量的默认值（着色器常量表），文件里没给的用它
const DEF = {
  SpriteFactors: [0, 0, 0, 1], Layer1TexCoordModifier: [1, 1, 0, 0], Layer2TexCoordModifier: [1, 1, 0, 0], Color1: [1, 1, 1, 0], Color2: [0.5, 0.5, 0.5, 0], Color3: [0, 0, 0, 0],
  ColorMidpoint: [0.5, 0, 0, 0], UseWorldScale: [0, 0, 0, 0], Layer1TexCoordSpeed: [0, 0, 0, 0], Layer2TexCoordSpeed: [0, 0, 0, 0], SpriteColor: [1, 1, 1, 1], Brightness: [1, 1, 1, 1],
  AtlasInfo: [6, 6, 10, 1], Colors: [0, 1, 1, 0.01], Colors2: [1, 1, 1, 1], VelocityStretch: [0, 0, 0, 0], SpriteFactors2: [0.05, 1, 1, 1], DistanceScalingParams: [0, 100, 1, 0.5],
  GeneralParams: [1, 0, 0, 0], TextureScroll1: [0, 0, 0, 0], TextureScroll2: [0, 0, 0, 0], TextureTransform1: [0, 0, 1, 1], TextureTransform2: [0, 0, 1, 1],
  FresnelFactors: [0, 1, 0, 0], DiffuseColor: [1, 1, 1, 1],
};
const PP_DEF = { p2l: [0, 100, 0.5, 0], pmv: [0, 100, 0.5, 0], pdyn: [0, 100, 0, 0] };
// 各贴图槽的寻址：颜色渐变 / 光晕渐变 / motionvector 的全部采样器是夹边，其余重复
const CLAMP_SLOTS = { cc: ['ColorRampMap'], flare: ['GradientMap'], pmv: ['TextureMap', 'ColorRampMap', 'GradientMap'] };

export function createEnvFx(scene, base) {
  base = String(base).replace(/\/?$/, '/');
  const defs = new Map(), geos = new Map(), texs = new Map(), vols = new Map();
  const insts = new Map();
  const shaderTime = { value: 0 };
  let t00 = null, frame = 0, gpuDef = null, viewPx = new THREE.Vector2(1920, 1080);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const white3 = new THREE.Data3DTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1);
  white3.needsUpdate = true;
  const loader = new THREE.TextureLoader();
  const warned = new Set();

  // ── 资源 ──
  function tex(name) {
    if (!texs.has(name)) {
      texs.set(name, new Promise((ok) => loader.load(`${base}tex/${name}.png?v=1`, (t) => {
        t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; ok(t);
      }, undefined, () => ok(white))));
    }
    return texs.get(name);
  }
  const clampCache = new Map();
  function clamped(t) {
    if (!t?.isTexture || t === white) return t;
    if (!clampCache.has(t)) { const c = t.clone(); c.wrapS = c.wrapT = THREE.ClampToEdgeWrapping; c.needsUpdate = true; clampCache.set(t, c); }
    return clampCache.get(t);
  }
  // 体积贴图：.bin（x 最快、再 y、再 z）；3 通道补成 RGBA；生成 mip（地平线附近云层坐标变化极快，没有 mip 会闪出噪点）
  function vol(name, dims) {
    if (!vols.has(name)) {
      vols.set(name, fetch(`${base}tex/${name}.bin?v=1`).then((r) => r.arrayBuffer()).then((b) => {
        const [w, h, d, c] = dims, src = new Uint8Array(b);
        let data = src, fmt = c === 1 ? THREE.RedFormat : THREE.RGBAFormat;
        if (c === 3) { data = new Uint8Array(w * h * d * 4); for (let i = 0; i < w * h * d; i++) { data[i * 4] = src[i * 3]; data[i * 4 + 1] = src[i * 3 + 1]; data[i * 4 + 2] = src[i * 3 + 2]; data[i * 4 + 3] = 255; } }
        const t = new THREE.Data3DTexture(data, w, h, d);
        t.format = fmt; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.unpackAlignment = 1; t.needsUpdate = true;
        return { tex: t, cpu: { w, h, d, c, data: src } };
      }).catch(() => ({ tex: white3, cpu: null })));
    }
    return vols.get(name);
  }
  function geo(name) {
    if (!geos.has(name)) {
      geos.set(name, fetch(`${base}mesh/${name}.json?v=1`).then((r) => r.json()).then((d) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(d.n.length ? d.n : new Array(d.p.length).fill(0), 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv.length ? d.uv : new Array(d.p.length / 3 * 2).fill(0), 2));
        g.setIndex(d.i);
        g.userData.areas = d.a?.length ? d.a : [[0, d.i.length]];
        return g;
      }).catch(() => null));
    }
    return geos.get(name);
  }
  // 特效定义：JSON + 用到的网格 / 贴图全部就绪才可用
  function load(name) {
    if (defs.has(name)) return defs.get(name);
    const d = { ok: false, json: null, geo: {}, tex: {}, vol: {} };
    defs.set(name, d);
    d.p = fetch(`${base}${name}.json?v=1`).then((r) => r.json()).then(async (j) => {
      const gs = new Set(), ts = new Set();
      JSON.stringify(j.root, (k, v) => { if (k === 'geo') gs.add(v); if (k === 'tex') ts.add(v); return v; });
      const v3 = j.tex3d || {};
      await Promise.all([
        ...[...gs].map(async (n) => { d.geo[n] = await geo(n); }),
        ...[...ts].map(async (n) => { if (v3[n]) d.vol[n] = await vol(n, v3[n]); else d.tex[n] = await tex(n); }),
        ...Object.keys(v3).filter((n) => !ts.has(n)).map(async (n) => { d.vol[n] = await vol(n, v3[n]); }),
      ]);
      if (!d.geo.unit_plane && name !== 'gpu') d.geo.unit_plane = await geo('unit_plane');
      d.json = j.root;
      d.ok = true;
    }).catch((e) => { console.warn('sim-env', name, e); });
    return d;
  }

  // ── 材质 ──
  function makeMaterial(kind, fx, d, area) {
    const S = SHADERS[kind];
    const uniforms = { uTime: shaderTime, uW: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uWS: { value: 1 } };
    for (const [k, v] of Object.entries(DEF)) uniforms[k] = { value: new THREE.Vector4(...v) };
    if (PP_DEF[kind]) uniforms.ParticleParams = { value: new THREE.Vector4(...PP_DEF[kind]) };
    for (const n of ['MaskMap', 'CloudMap', 'ColorRampMap', 'LightingMap', 'DiffuseMap1', 'DiffuseMap2', 'GradientMap', 'TexMapLayer1', 'TexMapLayer2', 'TextureMap', 'AtlasMap']) uniforms[n] = { value: white };
    uniforms.LightingWavesMap = { value: white3 };
    const params = [...(fx?.constParameters || []), ...(fx?.parameters || [])];
    for (const p of params) {
      const v = Array.isArray(p.value) ? p.value : [p.value ?? 0];
      uniforms[p.name] = { value: new THREE.Vector4(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0) };
    }
    for (const r of fx?.resources || []) {
      if (!r.tex) continue;
      if (d.vol[r.tex]) uniforms[r.name] = { value: d.vol[r.tex].tex };
      else if (d.tex[r.tex]) uniforms[r.name] = { value: CLAMP_SLOTS[kind]?.includes(r.name) ? clamped(d.tex[r.tex]) : d.tex[r.tex] };
    }
    const defines = {};
    if (kind === 'cc' && (fx?.options || []).some((o) => o.value === 'LIGHTNING_ENABLED')) defines.LIGHTNING = 1;
    const mat = new THREE.ShaderMaterial({ uniforms, defines, vertexShader: S.vs, fragmentShader: S.fs, side: THREE.DoubleSide, transparent: true, depthWrite: false });
    // 渲染状态：先套区域的标准模式（opaque 不混合写深度 / transparent SRCALPHA,INVSRCALPHA / additive ONE,ONE），再用 pass 自己的覆盖
    const one = () => { mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation; };
    if (area === 'opaqueAreas') { mat.blending = THREE.NoBlending; mat.transparent = false; mat.depthWrite = true; } else if (kind === 'bb' || kind === 'aoe') {
      one(); mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcColorFactor;
      if (kind === 'bb') { mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor; }   // 加法区域只写 RGB
    } else if (kind === 'cc' || kind === 'p2l' || kind === 'pdyn' || kind === 'gpu') {
      one(); mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    } else if (area === 'additiveAreas' || kind === 'fq') {
      one(); mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor; mat.blendSrcAlpha = THREE.ZeroFactor; mat.blendDstAlpha = THREE.OneFactor;
    } else mat.blending = THREE.NormalBlending;
    if (kind === 'uber') mat.side = THREE.FrontSide;   // ubershader 的 CULLMODE = 2（和 sim-cfx.js 同样的对应）
    return { mat, params };
  }
  function addMesh(geometry, mat, order) {
    const m = new THREE.Mesh(geometry, mat);
    m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = order; m.visible = false;
    scene.add(m);
    return m;
  }

  // ── 实例 ──
  function instantiate(d, entry) {
    const root = structuredClone(d.json);
    const ids = new Map();
    const collect = (o) => { if (Array.isArray(o)) o.forEach(collect); else if (o && typeof o === 'object') { if (o._id != null && !ids.has(o._id)) ids.set(o._id, o); Object.values(o).forEach(collect); } };
    collect(root);
    const fix = (o) => {
      if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { const v = o[i]; if (v && typeof v === 'object' && v._ref != null) o[i] = ids.get(v._ref) || null; else fix(v); } } else if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && v._ref != null) o[k] = ids.get(v._ref) || null; else fix(v); }
      }
    };
    fix(root);
    const inst = { entry, root, nodes: [], meshes: [], gpu: [], sets: root.curveSets || [], t0: null };
    const seen = new Set();
    const prep = (o) => {
      if (Array.isArray(o)) o.forEach(prep); else if (o && typeof o === 'object') {
        if (seen.has(o)) return;
        seen.add(o);
        if (o._type === 'Tr2CurveScalarExpression') o._rand = Math.random();
        if (o._type === 'Tr2ParticleSystem' && !o._rt) o._rt = new ParticleSystem(o);
        Object.values(o).forEach(prep);
      }
    };
    prep(root);
    const plane = d.geo.unit_plane;
    // 粒子系统的实例属性：同一个系统被几个节点画时共用
    const sysAttr = (sys, name, dim) => {
      const e = sys.el.get(name);
      if (!e) return new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, sys.max) * dim), dim);
      if (!e.attr) { e.attr = new THREE.InstancedBufferAttribute(e.a, e.dim); e.attr.setUsage(THREE.DynamicDrawUsage); }
      return e.attr;
    };
    const build = (node, parent) => {
      if (!node || typeof node !== 'object') return;
      const rec = { node, parent, W: new THREE.Matrix4(), vis: false };
      inst.nodes.push(rec);
      const mesh = node.mesh;
      if (node._type === 'EveChildQuad') {
        const kind = SHADER_OF[String(node.effect?.effectFilePath || '').split('/').pop().toLowerCase()];
        if (kind === 'fq') {
          const { mat } = makeMaterial('fq', null, d, 'additiveAreas');
          Object.assign(mat.uniforms, { uCenter: { value: new THREE.Vector3() }, uAxes: { value: new THREE.Vector4() }, uScale: { value: 1 }, uColor: { value: new THREE.Vector4() } });
          inst.meshes.push({ rec, kind, m: addMesh(plane, mat, 3), params: [] });
        }
      } else if (mesh && mesh._type === 'Tr2InstancedMesh') {
        const sys = mesh.instanceGeometryResource?._rt;
        if (sys && plane) {
          for (const list of ['opaqueAreas', 'transparentAreas', 'additiveAreas']) {
            for (const area of mesh[list] || []) {
              const kind = SHADER_OF[String(area.effect?.effectFilePath || '').split('/').pop().toLowerCase()];
              if (!['p2l', 'pmv', 'pdyn'].includes(kind)) { warnOnce(area.effect?.effectFilePath); continue; }
              const g = new THREE.InstancedBufferGeometry();
              for (const k of ['position', 'uv']) g.setAttribute(k, plane.getAttribute(k));
              g.setIndex(plane.getIndex());
              for (const [a, n, dim] of [['iPos', 'POS', 3], ['iVel', 'VEL', 3], ['iLife', 'LIFE', 2], ['iSize', 'size', 2], ['iSpin', 'spin', 1], ['iSpinVel', 'spinVel', 1], ['iAtlas', 'atlas', 1], ['iOffset', 'Offset', 4], ['iColor0', 'Color0', 4]]) g.setAttribute(a, sysAttr(sys, n, dim));
              g.instanceCount = 0;
              const { mat, params } = makeMaterial(kind, area.effect, d, list);
              inst.meshes.push({ rec, kind, sys, g, m: addMesh(g, mat, 2), params });
            }
          }
        }
      } else if (mesh && d.geo[mesh.geo]) {
        const base0 = d.geo[mesh.geo], areas = base0.userData.areas;
        for (const list of ['opaqueAreas', 'transparentAreas', 'additiveAreas']) {
          for (const area of mesh[list] || []) {
            const kind = SHADER_OF[String(area.effect?.effectFilePath || '').split('/').pop().toLowerCase()];
            if (!kind || !SHADERS[kind] || ['p2l', 'pmv', 'pdyn', 'fq', 'gpu'].includes(kind)) { warnOnce(area.effect?.effectFilePath); continue; }
            // Tr2MeshArea.index / count：网格里第 index 起 count 个区域的三角形
            const i0 = Math.min(area.index ?? 0, areas.length - 1), i1 = Math.min(i0 + (area.count ?? 1) - 1, areas.length - 1);
            const g = new THREE.BufferGeometry();
            for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, base0.getAttribute(k));
            g.setIndex(base0.getIndex());
            g.setDrawRange(areas[i0][0], areas[i1][0] + areas[i1][1] - areas[i0][0]);
            const { mat, params } = makeMaterial(kind, area.effect, d, list);
            const order = kind === 'cc' ? (list === 'opaqueAreas' ? 0 : -5) : kind === 'bb' ? 3 : 2;
            inst.meshes.push({ rec, kind, m: addMesh(g, mat, order), params });
          }
        }
      }
      for (const em of node.particleEmitters || []) if (em?._type === 'Tr2GpuUniqueEmitter') inst.gpu.push(makeGpuPool(em, rec));
      for (const c of node.objects || []) build(c, rec);
    };
    for (const c of root.effectChildren || []) build(c, null);
    return inst;
  }
  function warnOnce(p) { if (p && !warned.has(p)) { warned.add(p); console.warn('sim-env: 没有实现的着色器', p); } }

  // ── GPU 粒子（Tr2GpuUniqueEmitter → 计算着色器 emit / update 的 CPU 版）──
  const MAXG = 4096;
  function makeGpuPool(em, rec) {
    const pool = { em, rec, n: 0, pos: new Float64Array(MAXG * 3), vel: new Float64Array(MAXG * 3), age: new Float64Array(MAXG), life: new Float64Array(MAXG), hi: new Float64Array(MAXG),
      prev: null, prevDir: null, prevVel: [0, 0, 0], last: null, carry: 0, anim: 0 };
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    g.setAttribute('position', q.getAttribute('position')); g.setAttribute('uv', q.getAttribute('uv')); g.setIndex(q.getIndex());
    pool.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXG * 3), 3); pool.aVel = new THREE.InstancedBufferAttribute(new Float32Array(MAXG * 3), 3); pool.aAge = new THREE.InstancedBufferAttribute(new Float32Array(MAXG * 3), 3);
    for (const a of [pool.aPos, pool.aVel, pool.aAge]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', pool.aPos); g.setAttribute('iVel', pool.aVel); g.setAttribute('iAge', pool.aAge);
    g.instanceCount = 0;
    const uniforms = { uC0: { value: new THREE.Vector4() }, uC1: { value: new THREE.Vector4() }, uC2: { value: new THREE.Vector4() }, uC3: { value: new THREE.Vector4() },
      uSizes: { value: new THREE.Vector4() }, uMisc: { value: new THREE.Vector4() }, uView: { value: viewPx }, AtlasMap: { value: white } };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SHADERS.gpu.vs, fragmentShader: SHADERS.gpu.fs, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation });
    pool.g = g; pool.m = addMesh(g, mat, 2);
    pool.m.onBeforeRender = (r) => { r.getDrawingBufferSize(viewPx); };
    return pool;
  }
  const gv = new THREE.Vector3(), gq = new THREE.Quaternion(), gs = new THREE.Vector3(), nz = [0, 0, 0], nz2 = [0, 0, 0], nz3 = [0, 0, 0];
  function gpuUpdate(pool, time, frameCtx) {
    const em = pool.em, P = pool.rec.W, e = P.elements, gd = gpuDef;
    // 参数：scaledByParent 时按父矩阵的平均缩放放大尺寸、重力、湍流幅度、吸引力、半径、速度
    P.decompose(gv, gq, gs);
    const s = em.scaledByParent ? (gs.x + gs.y + gs.z) / 3 : 1;
    const sizes = (em.sizes || [0, 0, 0]).map((x) => x * s);
    const drag = em.drag ?? 0, turbA = (em.turbulenceAmplitude ?? 0) * s, turbF = (em.turbulenceFrequency ?? 1) / 4096, grav = (em.gravity ?? 0) * s, attS = (em.attractorStrength ?? 0) * s;
    const radius = (em.radius ?? 0) * s, vMin = (em.minSpeed ?? 0) * s, vMax = (em.maxSpeed ?? 0) * s;
    const lp = em.position || [0, 0, 0], ap = em.attractorPosition || [0, 0, 0];
    const pos = new THREE.Vector3(lp[0], lp[1], lp[2]).applyMatrix4(P), att = new THREE.Vector3(ap[0], ap[1], ap[2]).applyMatrix4(P);
    const dl = em.direction || [0, 1, 0];
    const dir = new THREE.Vector3(e[0] * dl[0] + e[4] * dl[1] + e[8] * dl[2], e[1] * dl[0] + e[5] * dl[1] + e[9] * dl[2], e[2] * dl[0] + e[6] * dl[1] + e[10] * dl[2]);
    const first = pool.last === null;
    const dt = first ? 0 : time - pool.last;
    pool.last = time;
    const vel = first ? new THREE.Vector3() : pos.clone().sub(pool.prev).divideScalar(Math.max(dt, 1e-6));
    if (first) { pool.prev = pos.clone(); pool.prevDir = dir.clone(); }
    // 更新（update.fx）：年龄 ≥ 寿命就死；重力、三层湍流、吸引、阻力，然后积分位置
    const vol3 = gd?.vol?.noise32cube_volume?.cpu;
    const sdt = Math.min(Math.max(dt, 0), 1 / 3);
    pool.anim += sdt * 0.05;
    const no = vol3 ? sampleVol(vol3, 0, 0, pool.anim / 32, [0, 0, 0]) : [0, 0, 0];
    for (let i = 0; i < pool.n; i++) {
      pool.age[i] += sdt;
      if (pool.age[i] >= pool.life[i]) {
        const j = --pool.n;
        if (i !== j) { for (let k = 0; k < 3; k++) { pool.pos[i * 3 + k] = pool.pos[j * 3 + k]; pool.vel[i * 3 + k] = pool.vel[j * 3 + k]; } pool.age[i] = pool.age[j]; pool.life[i] = pool.life[j]; pool.hi[i] = pool.hi[j]; }
        i--;
        continue;
      }
      const o = i * 3;
      let vx = pool.vel[o], vy = pool.vel[o + 1] + grav * sdt, vz = pool.vel[o + 2];
      if (vol3 && turbA) {
        const px = pool.pos[o] * turbF + no[0], py = pool.pos[o + 1] * turbF + no[1], pz = pool.pos[o + 2] * turbF + no[2];
        const a = sampleVol(vol3, px, py, pz, nz), b = sampleVol(vol3, pz * 2, py * 2, px * 2, nz2), c = sampleVol(vol3, px * 4, py * 4, pz * 4, nz3);
        vx += turbA * ((a[0] - 0.5) + (b[0] - 0.5) * 0.5 + (c[0] - 0.5) * 0.25) * sdt;
        vy += turbA * ((a[1] - 0.5) + (b[1] - 0.5) * 0.5 + (c[1] - 0.5) * 0.25) * sdt;
        vz += turbA * ((a[2] - 0.5) + (b[2] - 0.5) * 0.5 + (c[2] - 0.5) * 0.25) * sdt;
      }
      if (attS !== 0) {
        const dx = att.x - pool.pos[o], dy = att.y - pool.pos[o + 1], dz = att.z - pool.pos[o + 2], l = Math.hypot(dx, dy, dz) || 1;
        vx += dx / l * attS * sdt; vy += dy / l * attS * sdt; vz += dz / l * attS * sdt;
      }
      if (drag < 0) { const sp = Math.hypot(vx, vy, vz); vx += sp * vx * drag * sdt; vy += sp * vy * drag * sdt; vz += sp * vz * drag * sdt; } else { vx -= drag * vx * sdt; vy -= drag * vy * sdt; vz -= drag * vz * sdt; }
      pool.vel[o] = vx; pool.vel[o + 1] = vy; pool.vel[o + 2] = vz;
      pool.pos[o] += vx * sdt; pool.pos[o + 1] += vy * sdt; pool.pos[o + 2] += vz * sdt;
    }
    // 发射（emit.fx）：上一帧到这一帧之间插值位置 / 方向；方向在圆锥里随机转 θ（张角 ≥ π/2 时整个球面）；位置在半径上，速度沿方向
    if ((em.continuousEmitter ?? true) && em.rate > 0 && dt > 0) {
      let total = pool.carry + Math.min(dt, 1 / 15) * em.rate;
      if (pos.distanceTo(pool.prev) > (em.maxDisplacement ?? 1000)) total = 0;
      pool.carry = total - Math.floor(total);
      const cnt = Math.max(0, Math.trunc(total));
      const amax = (em.angle ?? 0) >= Math.PI / 2 ? Math.PI : em.angle ?? 0, inner = em.innerAngle ?? 0, inh = em.inheritVelocity ?? 1;
      const d = new THREE.Vector3(), ax = new THREE.Vector3(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
      for (let k = 0; k < cnt && pool.n < MAXG; k++) {
        const f = Math.random();
        d.copy(pool.prevDir).lerp(dir, f).normalize();
        ax.set(Math.abs(d.y) < Math.abs(d.x) ? 0 : 1, Math.abs(d.y) < Math.abs(d.x) ? 1 : 0, 0).cross(d).normalize();
        q.setFromAxisAngle(ax, inner + Math.random() * (amax - inner));
        q2.setFromAxisAngle(d, Math.random() * Math.PI * 2);
        const r = d.clone().applyQuaternion(q).applyQuaternion(q2);
        const i = pool.n++, o = i * 3, sp = vMin + Math.random() * (vMax - vMin);
        const bx = pool.prev.x + (pos.x - pool.prev.x) * f, by = pool.prev.y + (pos.y - pool.prev.y) * f, bz = pool.prev.z + (pos.z - pool.prev.z) * f;
        pool.pos[o] = bx + r.x * radius; pool.pos[o + 1] = by + r.y * radius; pool.pos[o + 2] = bz + r.z * radius;
        pool.vel[o] = r.x * sp + (pool.prevVel[0] + (vel.x - pool.prevVel[0]) * f) * inh;
        pool.vel[o + 1] = r.y * sp + (pool.prevVel[1] + (vel.y - pool.prevVel[1]) * f) * inh;
        pool.vel[o + 2] = r.z * sp + (pool.prevVel[2] + (vel.z - pool.prevVel[2]) * f) * inh;
        pool.age[i] = 0;
        pool.hi[i] = Math.floor(Math.random() * 65536) / 65536;
        pool.life[i] = (em.minLifeTime ?? 0) + pool.hi[i] * ((em.maxLifeTime ?? 0) - (em.minLifeTime ?? 0));
      }
    }
    pool.prev.copy(pos); pool.prevDir.copy(dir); pool.prevVel = [vel.x, vel.y, vel.z];
    // 绘制：视锥 + 屏幕尺寸 > 2 像素的才画（cb1[43] 按视口像素尺寸）
    const { egoA, frustum, viewM, p00 } = frameCtx;
    const smax = Math.max(...sizes) * (Math.abs(em.sizeVariance ?? 0) + 1);
    let n = 0;
    const ap2 = pool.aPos.array, av = pool.aVel.array, aa = pool.aAge.array, tmp = new THREE.Vector3();
    for (let i = 0; i < pool.n; i++) {
      const o = i * 3;
      const rx = pool.pos[o] - egoA[0], ry = pool.pos[o + 1] - egoA[1], rz = pool.pos[o + 2] - egoA[2];
      tmp.set(rx, ry, rz).applyMatrix4(viewM);
      const depth = -tmp.z;
      if (!frustum(tmp, smax)) continue;
      if (smax / Math.max(depth, 1) * p00 * viewPx.x <= 2) continue;
      ap2[n * 3] = rx; ap2[n * 3 + 1] = ry; ap2[n * 3 + 2] = rz;
      av[n * 3] = pool.vel[o]; av[n * 3 + 1] = pool.vel[o + 1]; av[n * 3 + 2] = pool.vel[o + 2];
      aa[n * 3] = pool.age[i]; aa[n * 3 + 1] = pool.life[i]; aa[n * 3 + 2] = pool.hi[i];
      n++;
    }
    pool.g.instanceCount = n;
    for (const a of [pool.aPos, pool.aVel, pool.aAge]) { a.needsUpdate = true; a.clearUpdateRanges?.(); }
    const u = pool.m.material.uniforms, C = (c) => c || [0, 0, 0, 0];
    u.uC0.value.fromArray(C(em.color0)); u.uC1.value.fromArray(C(em.color1)); u.uC2.value.fromArray(C(em.color2)); u.uC3.value.fromArray(C(em.color3));
    u.uSizes.value.set(sizes[0], sizes[1], sizes[2], em.sizeVariance ?? 0);
    const mid = em.colorMidpoint ?? 0.5;
    u.uMisc.value.set((em.textureIndex ?? 0) + Math.min(0.99, Math.max(0.001, 1 - mid - Math.floor(mid))), em.velocityStretchRotation ?? 0, 0, 0);
    if (gd?.tex?.systematlas) u.AtlasMap.value = gd.tex.systematlas;
    pool.m.visible = n > 0;
  }

  // ── 每帧：曲线 → 节点矩阵 → 粒子 → 网格 ──
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), qA = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3();
  const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
  function updateInst(inst, ctx) {
    const { time, camA, egoA, axes } = ctx;
    if (inst.t0 === null) inst.t0 = time;
    const ct = time - inst.t0;
    for (const set of inst.sets) {
      if (set.playOnLoad === false) continue;
      const t = ct * (set.scale ?? 1);
      for (const c of set.curves || []) c.currentValue = curveValue(c, t);
      for (const b of set.bindings || []) applyBinding(b);
    }
    // 根节点：放在 posA（客户端坐标，米）；边界泡按 r / 75 km 缩放
    const e = inst.entry, root = inst.root;
    const rootW = new THREE.Matrix4().makeTranslation(inst.posA[0], inst.posA[1], inst.posA[2]);
    if (root.rotation || root.scaling) rootW.multiply(mA.compose(vA.set(0, 0, 0), qA.fromArray(root.rotation || [0, 0, 0, 1]), vB.fromArray(root.scaling || [1, 1, 1])));
    if (e.kind === 'boundary' && e.r > 0) rootW.multiply(mA.makeScale(e.r / BOUNDARY_R, e.r / BOUNDARY_R, e.r / BOUNDARY_R));
    for (const rec of inst.nodes) {
      const n = rec.node, pW = rec.parent ? rec.parent.W : rootW;
      rec.vis = (rec.parent ? rec.parent.vis : true) && !(n.display != null && !n.display);
      if (!rec.vis) continue;
      const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scaling || [1, 1, 1];
      rec.W.copy(pW).multiply(mA.compose(vA.fromArray(t), qA.set(r[0], r[1], r[2], r[3]), vB.fromArray(s)));
      for (const mod of n.transformModifiers || []) {
        const w = rec.W.elements;
        if (mod._type === 'EveChildModifierTranslateWithCamera') {
          // 平移 += 镜头位置（客户端世界原点是 ego，所以是镜头相对 ego 的位置）；attachedToCamera 时直接等于镜头位置
          if (mod.attachedToCamera) { w[12] = camA[0]; w[13] = camA[1]; w[14] = camA[2]; } else { w[12] += camA[0] - egoA[0]; w[13] += camA[1] - egoA[1]; w[14] += camA[2] - egoA[2]; }
        } else if (mod._type === 'EveChildModifierBillboard2D') {
          // 三个轴换成镜头的 右 / 上 / 后（客户端坐标），各乘原来的轴长
          const sx = Math.hypot(w[0], w[1], w[2]), sy = Math.hypot(w[4], w[5], w[6]), sz = Math.hypot(w[8], w[9], w[10]);
          for (let k = 0; k < 3; k++) { w[k] = axes[0][k] * sx; w[4 + k] = axes[1][k] * sy; w[8 + k] = axes[2][k] * sz; }
        }
      }
    }
    // 粒子：每个粒子节点先更新自己的发射器，再更新自己的粒子系统（共用的系统一帧只更新一次）
    for (const rec of inst.nodes) {
      if (!rec.vis) continue;
      for (const em of rec.node.particleEmitters || []) if (em?._type === 'Tr2DynamicEmitter') emitterUpdate(em, time);
      for (const ps of rec.node.particleSystems || []) ps?._rt?.update(time, frame);
    }
    for (const pool of inst.gpu) { if (pool.rec.vis) gpuUpdate(pool, time, ctx); else pool.m.visible = false; }
    // 网格
    const relEgo = mB.makeTranslation(-egoA[0], -egoA[1], -egoA[2]);
    for (const it of inst.meshes) {
      const { rec, m } = it;
      m.visible = rec.vis;
      if (!rec.vis) continue;
      const u = m.material.uniforms;
      for (const p of it.params) { const v = Array.isArray(p.value) ? p.value : [p.value ?? 0]; u[p.name]?.value.set?.(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0); }
      if (it.kind === 'fq') {
        // EveChildQuad：中心 = 父矩阵 × 自己的平移；角点按局部矩阵左上 2×2 展开 × 父矩阵平均缩放
        const pW = rec.parent ? rec.parent.W : mA.identity(), n = rec.node, t = n.translation || [0, 0, 0];
        vA.fromArray(t).applyMatrix4(pW).applyMatrix4(relEgo);
        u.uCenter.value.copy(vA);
        const L = new THREE.Matrix4().compose(vB.set(0, 0, 0), qA.fromArray(n.rotation || [0, 0, 0, 1]), new THREE.Vector3().fromArray(n.scaling || [1, 1, 1])).elements;
        u.uAxes.value.set(L[0], L[1], L[4], L[5]);
        const pe = pW.elements;
        u.uScale.value = Math.hypot(pe[0] + pe[4] + pe[8], pe[1] + pe[5] + pe[9], pe[2] + pe[6] + pe[10]) * 0.57735;
        const c = n.color || [1, 1, 1, 1], b = n.brightness ?? 1;
        u.uColor.value.set(c[0] * b, c[1] * b, c[2] * b, 1);
        m.matrix.copy(ctx.toScene);
      } else {
        const Wr = u.uW.value.multiplyMatrices(relEgo, rec.W);
        m.matrix.multiplyMatrices(ctx.toScene, Wr);
        const we = Wr.elements;
        u.uWS.value = Math.hypot(we[0] + we[4] + we[8], we[1] + we[5] + we[9], we[2] + we[6] + we[10]) * 0.57735;
        u.uCam.value.set(camA[0] - egoA[0], camA[1] - egoA[1], camA[2] - egoA[2]);
        if (it.sys) {
          it.g.instanceCount = it.sys.alive;
          for (const el of it.sys.el.values()) if (el.attr && el.attr._frame !== frame) { el.attr._frame = frame; el.attr.needsUpdate = true; }
          m.visible = it.sys.alive > 0;
        }
      }
    }
    for (const pool of inst.gpu) pool.m.matrix.copy(ctx.toScene);
  }

  function disposeInst(inst) {
    for (const it of inst.meshes) { scene.remove(it.m); it.m.material.dispose(); if (it.g) it.g.dispose(); else if (it.kind !== 'fq') it.m.geometry.dispose(); }
    for (const p of inst.gpu) { scene.remove(p.m); p.m.material.dispose(); p.g.dispose(); }
  }
  const keyOf = (e) => e.kind === 'cover' ? `cover:${e.weather}:${(e.pos || []).map((x) => Math.round(x)).join(',')}`
    : `${e.kind}:${e.type ?? ''}:${(e.pos || []).map((x) => Math.round(x)).join(',')}:${Math.round(e.r || 0)}`;
  const fileOf = (e) => e.kind === 'boundary' ? 'boundary' : e.kind === 'cloud' ? CLOUD_FILE[e.type] : e.kind === 'cover' && WEATHERS.includes(e.weather) ? `cc_${e.weather}` : null;
  let wanted = [];

  return {
    // list：[{ kind:'boundary', pos:[x,y,z](米，世界坐标), r }, { kind:'cloud', type: SDE 类型, pos, r }, { kind:'cover', weather, pos? }]
    set(list) {
      wanted = (list || []).filter((e) => e && fileOf(e));
      const keep = new Set(wanted.map(keyOf));
      for (const [k, inst] of insts) if (!keep.has(k)) { disposeInst(inst); insts.delete(k); }
      for (const e of wanted) load(fileOf(e));
      if (wanted.some((e) => e.kind === 'cloud')) gpuDef = load('gpu');
    },
    // camera：场景镜头；ORG：浮动原点（米）；time：秒；ego（可选）：自己的船在场景里的位置（千米，相对 ORG），默认用镜头位置
    update(camera, ORG, time, ego) {
      if (!wanted.length && !insts.size) return;
      frame++;
      if (t00 === null) t00 = time;
      shaderTime.value = time - t00;
      const O = ORG || [0, 0, 0];
      const toSim = (v) => [v.x / KM + O[0], v.y / KM + O[1], v.z / KM + O[2]];
      const camS = toSim(camera.position), egoS = ego ? toSim(ego) : camS;
      const mir = (p) => [-p[0], p[1], p[2]];
      const camA = mir(camS), egoA = mir(egoS);
      // 客户端坐标（相对 ego）→ 场景：沿 X 镜像、米换千米、平移到 ego 在场景里的位置
      const toScene = new THREE.Matrix4().makeTranslation((egoS[0] - O[0]) * KM, (egoS[1] - O[1]) * KM, (egoS[2] - O[2]) * KM).multiply(new THREE.Matrix4().makeScale(-KM, KM, KM));
      camera.updateMatrixWorld();
      const cm = camera.matrixWorld.elements;
      const axes = [[-cm[0], cm[1], cm[2]], [-cm[4], cm[5], cm[6]], [-cm[8], cm[9], cm[10]]].map((a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); });
      // GPU 粒子的裁剪：客户端坐标（相对 ego）→ 镜头空间（米）
      const viewM = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, toScene).premultiply(new THREE.Matrix4().makeScale(1 / KM, 1 / KM, 1 / KM));
      const pe = camera.projectionMatrix.elements, p00 = pe[0], p11 = pe[5];
      const frustum = (v, r) => { const z = -v.z; if (z + r < 0) return false; return Math.abs(v.x) * p00 <= z + r * (1 + p00) && Math.abs(v.y) * p11 <= z + r * (1 + p11); };
      const ctx = { time, camA, egoA, axes, toScene, viewM, p00, frustum };
      const bnd = wanted.find((e) => e.kind === 'boundary');
      for (const e of wanted) {
        const k = keyOf(e);
        let inst = insts.get(k);
        if (!inst) {
          const d = defs.get(fileOf(e));
          if (!d?.ok || (e.kind === 'cloud' && !gpuDef?.ok)) continue;
          inst = instantiate(d, e);
          // 天气云层的放置：给了 pos 用 pos，否则用边界泡中心，再没有用当时 ego 的位置
          const p = e.pos || (e.kind === 'cover' ? bnd?.pos || egoS : [0, 0, 0]);
          inst.posA = mir(p);
          insts.set(k, inst);
        }
        updateInst(inst, ctx);
      }
    },
    dispose() {
      for (const inst of insts.values()) disposeInst(inst);
      insts.clear();
      wanted = [];
      for (const p of texs.values()) p.then((t) => t?.dispose?.());
      for (const t of clampCache.values()) t.dispose();
      for (const p of vols.values()) p.then((v) => v?.tex?.dispose?.());
      for (const p of geos.values()) p.then((g) => g?.dispose?.());
      white.dispose(); white3.dispose();
    },
  };
}
