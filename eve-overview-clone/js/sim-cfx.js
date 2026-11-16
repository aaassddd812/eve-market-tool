// ===== 驾驶模拟：按游戏客户端的装备特效文件播放电子战特效（three.js）=====
// 数据：tools/ship-models/fx-effects.mjs 把 fisfx/module/*.black 转成 assets/eveui/fx/cfx/<类别>.json（对象树原样保留）+ 网格 + 贴图。
// 这里是一个只覆盖这些文件用到的部分的小运行时，逐条照解析库（@carbonenginejs）里对应类的实现：
//   曲线 Tr2CurveScalar（常量 / 线性 / Hermite，前后外推 夹住 / 循环 / 镜像 / 线性）、表达式曲线 Tr2CurveScalarExpression
//   （fractal / randconst / input / inputAt，随机常数每个实例一个）、曲线组 TriCurveSet（play_start 每个装备周期从 0 重播，
//   其余 playOnLoad 的按 scale 走时间）、绑定 TriValueBinding（目标 = 源 × scale + offset，按列表顺序拷）；
//   节点 EveTransform（T·R·S，修饰 100 朝镜头对齐 / 3 看向镜头）、拉伸 EveStretch（起点物体 / 终点物体 / 拉伸体，
//   拉伸体本地 −Z 指向目标、Z 方向按长度缩放）；客户端 StretchEffect 的端点 = 两船包围盒 ×1.2 的椭球面上朝向对方的点。
// 着色器照客户端 effect.dx11 的反汇编：ubershader（默认分支：两张滚动贴图 × 遮罩 × 颜色 × 菲涅尔，任一张为 0 就丢弃）、
//   ubershadertwosided（同上，菲涅尔按顶点）、ubershadercube（扰动法线后反射取立方体贴图）、lensflares/flare（按半径查渐变）。
//   additiveAreas = RM_ALPHA_ADDITIVE（ONE, ONE，不乘 alpha）、transparentAreas = RM_ALPHA（SRCALPHA, INVSRCALPHA），见 Tr2EffectStateManager；剔除按着色器的渲染状态（CULLMODE）。
// 坐标：场景坐标 = 客户端坐标（右手系，见 sim-ships.js），这里先按米算完，再换成千米放进场景。
// 网格和贴图版权归 CCP。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOG_F = '#include <common>\n#include <logdepthbuf_pars_fragment>\n';
const TO_SCENE = new THREE.Matrix4().makeScale(KM, KM, KM);   // 客户端（米）→ 场景（千米）

// ── 曲线 ──
const hermite = (v0, t0, v1, t1, s) => { const s2 = s * s, s3 = s2 * s; return v0 * (2 * s3 - 3 * s2 + 1) + t0 * (s3 - 2 * s2 + s) + v1 * (3 * s2 - 2 * s3) + t1 * (s3 - s2); };
function wrapTime(t, first, last, before, after) {
  const len = last - first;
  if (len === 0) return first;
  if (t < first) {
    const q = -(t - first) / len, ip = Math.trunc(q);
    let f = q - ip;
    if (before === 1) f = 1 - f; else if (ip % 2 !== 0) f = 1 - f;
    return f * len + first;
  }
  if (t <= last) return t;
  const q = (t - first) / len, ip = Math.trunc(q);
  let f = q - ip;
  if (after === 2 && ip % 2 !== 0) f = 1 - f;
  return f * len + first;
}
function scalarAt(c, time) {
  const K = c.keys || [];
  if (!K.length) return 0;
  const t = time / (c.timeScale ?? 1) - (c.timeOffset ?? 0);
  const k0 = K[0], kn = K[K.length - 1], eb = c.extrapolationBefore ?? 0, ea = c.extrapolationAfter ?? 0;
  if (eb === 3 && t < k0.time) return k0.value - (k0.time - t) * (k0.leftTangent ?? 0);
  if (ea === 3 && t > kn.time) return kn.value + (t - kn.time) * (kn.rightTangent ?? 0);
  if (K.length === 1) return k0.value;
  if (eb === 0 && t <= k0.time) return k0.value;
  if (ea === 0 && t >= kn.time) return kn.value;
  const lt = wrapTime(t, k0.time, kn.time, eb, ea);
  let i = 0;
  while (i < K.length - 2 && lt >= K[i + 1].time) i++;
  const a = K[i], b = K[i + 1];
  const it = a.interpolation ?? 0;
  if (it === 0) return lt === b.time ? b.value : a.value;
  if (it === 1) return b.time === a.time ? b.value : a.value + (b.value - a.value) * (lt - a.time) / (b.time - a.time);
  const len = b.time - a.time;
  if (len === 0) return b.value;
  return hermite(a.value, (a.rightTangent ?? 0) * len, b.value, (b.leftTangent ?? 0) * len, (lt - a.time) / len);
}
// 1D Perlin（客户端 TriPerlinNoise：256 个随机梯度、S 曲线插值；种子不同，噪声形状不同但统计特性一样）
const GRAD = (() => { let s = 1; return Float64Array.from({ length: 256 }, () => { s = (s * 1103515245 + 12345) >>> 0; return ((s >>> 8) % 512 - 256) / 256; }); })();
const perlin = (x) => { const f = Math.floor(x), a = f & 255, b = (a + 1) & 255, x0 = x - f, x1 = x0 - 1, u = x0 * x0 * (3 - 2 * x0); return x0 * GRAD[a] + u * (x1 * GRAD[b] - x0 * GRAD[a]); };
const fractal = (x, invAmp, freq, oct) => { let sum = 0, sc = 1; for (let i = 0; i < oct; i++) { sum += perlin(x) * sc; sc /= invAmp; x *= freq; } return sum; };
// 表达式：数字、time / input1~4、函数调用、+ - * /、比较、?:、括号
function compileExpr(src) {
  const tok = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|>=|<=|==|!=|&&|\|\||[-+*/(),?:<>!]/g) || [];
  let p = 0;
  const peek = () => tok[p], eat = (x) => { if (tok[p] !== x) throw new Error(`表达式 ${src}：缺 ${x}`); p++; };
  const prim = () => {
    const t = tok[p++];
    if (t === '(') { const e = ternary(); eat(')'); return e; }
    if (t === '-') { const e = prim(); return (c) => -e(c); }
    if (t === '!') { const e = prim(); return (c) => (e(c) ? 0 : 1); }
    if (/^[\d.]/.test(t)) { const v = +t; return () => v; }
    if (peek() === '(') {
      p++;
      const a = [];
      if (peek() !== ')') { a.push(ternary()); while (peek() === ',') { p++; a.push(ternary()); } }
      eat(')');
      const f = FN[t];
      if (!f) throw new Error(`表达式 ${src}：不认识 ${t}`);
      return (c) => f(c, ...a.map((x) => x(c)));
    }
    return (c) => c.vars[t] ?? 0;
  };
  const bin = (next, ops) => () => { let l = next(); while (ops[peek()]) { const op = ops[tok[p++]], r = next(), L = l; l = (c) => op(L(c), r(c)); } return l; };
  const mul = bin(prim, { '*': (a, b) => a * b, '/': (a, b) => a / b });
  const add = bin(mul, { '+': (a, b) => a + b, '-': (a, b) => a - b });
  const cmp = bin(add, { '>': (a, b) => +(a > b), '<': (a, b) => +(a < b), '>=': (a, b) => +(a >= b), '<=': (a, b) => +(a <= b), '==': (a, b) => +(a === b), '!=': (a, b) => +(a !== b) });
  const and = bin(cmp, { '&&': (a, b) => +(a && b), '||': (a, b) => +(a || b) });
  const ternary = () => { const c = and(); if (peek() !== '?') return c; p++; const a = ternary(); eat(':'); const b = ternary(); return (x) => (c(x) ? a(x) : b(x)); };
  return ternary();
}
const FN = {
  randconst: (c, lo = 0, hi = 1) => lo + c.curve._rand * (hi - lo),
  randomConstant: (c, lo = 0, hi = 1) => lo + c.curve._rand * (hi - lo),
  random: (c, lo = 0, hi = 1) => lo + Math.random() * (hi - lo),
  noise: (c, x) => (fractal(x + c.curve._rand, 1, 1, 1) + 1) / 2,
  fractal: (c, x, a, b, n) => (fractal(x + c.curve._rand, a, b, Math.trunc(n + 0.5)) + 1) / 2,
  input: (c, i) => curveAt(c.curve.inputs?.[i | 0], c.time),
  inputAt: (c, i, t) => curveAt(c.curve.inputs?.[i | 0], t),
  sin: (c, x) => Math.sin(x), cos: (c, x) => Math.cos(x), abs: (c, x) => Math.abs(x), min: (c, a, b) => Math.min(a, b), max: (c, a, b) => Math.max(a, b),
  clamp: (c, x, a, b) => Math.min(b, Math.max(a, x)), lerp: (c, a, b, x) => a * (1 - x) + b * x, pow: (c, a, b) => a ** b, sqrt: (c, x) => Math.sqrt(x),
};
function curveAt(c, time) {
  if (!c) return 0;
  if (c._type === 'Tr2CurveScalarExpression') {
    if (!c._fn) { try { c._fn = c.expression ? compileExpr(c.expression) : () => 0; } catch (e) { console.warn(e.message); c._fn = () => 0; } }
    const t = time / (c.timeScale ?? 1);
    return Number(c._fn({ curve: c, time: t, vars: { time: t, input1: c.input1 ?? 0, input2: c.input2 ?? 0, input3: c.input3 ?? 0, input4: c.input4 ?? 0 } })) || 0;
  }
  if (c._type === 'Tr2CurveScalar') return scalarAt(c, time);
  return c.currentValue ?? 0;
}

// ── 绑定：属性路径读写（value / value.y / scaling.x / currentValue / input1 / scale / brightness …）──
const COMP = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
function readAttr(o, attr) {
  if (!o) return 0;
  const [k, c] = attr.split('.');
  const v = o[k];
  if (c != null) return Array.isArray(v) ? v[COMP[c]] ?? 0 : 0;
  return v ?? 0;
}
function copyBinding(b) {
  const src = b.sourceObject, dst = b.destinationObject;
  if (!src || !dst || !b.sourceAttribute || !b.destinationAttribute) return;
  const s = b.scale ?? 1, off = b.offset || [0, 0, 0, 0];
  const v = readAttr(src, b.sourceAttribute);
  const [k, c] = b.destinationAttribute.split('.');
  if (c != null) {
    if (!Array.isArray(dst[k])) dst[k] = [0, 0, 0, 0];
    const i = COMP[c];
    dst[k][i] = (Array.isArray(v) ? v[0] : v) * s + off[i];
  } else if (Array.isArray(v)) {
    dst[k] = v.map((x, i) => x * s + off[i]);
  } else if (Array.isArray(dst[k])) {
    dst[k] = dst[k].map((_, i) => v * s + off[i]);
  } else {
    dst[k] = v * s + off[0];
  }
}

// ── 着色器 ──
const uberVS = `${LOG_V} varying vec2 vUv; varying vec3 vN, vV;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vUv = uv; vN = mat3(modelMatrix) * normal; vV = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const FRES = `float fres(vec3 V, vec3 N, vec4 F) {
    float x = pow(1.0 - clamp(dot(V, N) - F.z, 0.0, 1.0), F.x);
    return F.y < 0.0 ? (1.0 - min(x, 1.0)) * -F.y : x * F.y;
  }`;
const SHADERS = {
  // ubershader.fx 默认分支（DIFFUSE_MAP_COUNT = TWO、遮罩 WRAP、不做遮罩变换）；CULLMODE = 2
  uber: { side: THREE.FrontSide, vs: uberVS, fs: `${LOG_F} uniform sampler2D DiffuseMap1, DiffuseMap2, MaskMap; uniform vec4 DiffuseColor, TextureScroll1, TextureScroll2, TextureTransform1, TextureTransform2, FresnelFactors; uniform float time;
    varying vec2 vUv; varying vec3 vN, vV; ${FRES}
    void main() {
      #include <logdepthbuf_fragment>
      vec4 a = texture2D(DiffuseMap1, vUv * TextureTransform1.zw + TextureTransform1.xy + TextureScroll1.xy * time + TextureScroll1.zw);
      if (dot(a, a) == 0.0) discard;
      vec4 b = texture2D(DiffuseMap2, vUv * TextureTransform2.zw + TextureTransform2.xy + TextureScroll2.xy * time + TextureScroll2.zw);
      if (dot(b, b) == 0.0) discard;
      vec4 m = texture2D(MaskMap, vUv);
      if (dot(m, m) == 0.0) discard;
      vec4 c = a * b * m * DiffuseColor;
      c.rgb *= fres(normalize(vV), normalize(vN), FresnelFactors);
      gl_FragColor = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
    }` },
  // ubershadertwosided.fx：菲涅尔在顶点里算；CULLMODE = 2
  uber2: { side: THREE.FrontSide, clamp: ['MaskMap'], vs: `${LOG_V} uniform vec4 TextureScroll1, TextureScroll2, TextureTransform1, TextureTransform2, FresnelFactors; uniform float time;
    varying vec2 vUv; varying vec4 vUv12; varying float vF; ${FRES}
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vUv = uv;
      vUv12 = vec4(uv * TextureTransform1.zw + TextureTransform1.xy + TextureScroll1.xy * time + TextureScroll1.zw, uv * TextureTransform2.zw + TextureTransform2.xy + TextureScroll2.xy * time + TextureScroll2.zw);
      // 法线用世界矩阵的逆转置（伴随矩阵 × 行列式符号），和客户端单独传的法线矩阵一致
      mat3 M = mat3(modelMatrix);
      mat3 C = mat3(cross(M[1], M[2]), cross(M[2], M[0]), cross(M[0], M[1]));
      vec3 N = normalize(C * normal) * sign(dot(M[0], cross(M[1], M[2])));
      vF = fres(normalize(cameraPosition - wp.xyz), N, FresnelFactors);
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`, fs: `${LOG_F} uniform sampler2D DiffuseMap1, DiffuseMap2, MaskMap; uniform vec4 DiffuseColor; varying vec2 vUv; varying vec4 vUv12; varying float vF;
    void main() {
      #include <logdepthbuf_fragment>
      gl_FragColor = texture2D(DiffuseMap1, vUv12.xy) * texture2D(DiffuseMap2, vUv12.zw) * texture2D(MaskMap, vUv) * vF * DiffuseColor;
    }` },
  // ubershadercube.fx：没有剔除状态（默认剔除）；反射方向用镜头朝向（客户端 cb2[6]）
  cube: { side: THREE.BackSide, vs: uberVS, fs: `${LOG_F} uniform sampler2D DiffuseMap1, DiffuseMap2, MaskMap; uniform samplerCube MainCubeMap; uniform vec4 DiffuseColor, TextureScroll1, TextureScroll2, TextureTransform1, TextureTransform2; uniform vec3 ScaleAlongNormal, camF; uniform float time;
    varying vec2 vUv; varying vec3 vN, vV;
    void main() {
      #include <logdepthbuf_fragment>
      vec4 a = texture2D(DiffuseMap1, vUv * TextureTransform1.zw + TextureTransform1.xy + TextureScroll1.xy * time + TextureScroll1.zw)
             * texture2D(DiffuseMap2, vUv * TextureTransform2.zw + TextureTransform2.xy + TextureScroll2.xy * time + TextureScroll2.zw) * texture2D(MaskMap, vUv);
      vec3 r = reflect(camF, normalize(a.rgb * ScaleAlongNormal + normalize(vN)));
      gl_FragColor = vec4(textureCube(MainCubeMap, r).rgb, a.a) * DiffuseColor;
    }` },
  // lensflares/flare.fx：CULLMODE = 1（不剔除）
  flare: { side: THREE.DoubleSide, clamp: ['GradientMap'], vs: uberVS, fs: `${LOG_F} uniform sampler2D GradientMap; uniform vec4 DiffuseColor; uniform float Brightness; varying vec2 vUv;
    void main() {
      #include <logdepthbuf_fragment>
      float r = length((vUv - 0.5) * 2.0);
      gl_FragColor = texture2D(GradientMap, vec2(r, r)) * DiffuseColor * Brightness;
    }` },
};
const SHADER_OF = { 'ubershader.fx': 'uber', 'ubershadertwosided.fx': 'uber2', 'ubershadercube.fx': 'cube', 'flare.fx': 'flare' };

export function createClientFx(scene, base) {
  base = base.replace(/\/?$/, '/');
  const time = { value: 0 }, camF = { value: new THREE.Vector3() };
  const defs = new Map(), geos = new Map(), texs = new Map();
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.needsUpdate = true;
  const texLoader = new THREE.TextureLoader();
  function tex(name, cube) {
    if (!texs.has(name)) {
      texs.set(name, new Promise((ok) => {
        const done = (t) => { t.colorSpace = THREE.NoColorSpace; ok(t); };
        if (cube) new THREE.CubeTextureLoader().setPath(`${base}tex/${name}/`).load(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => f + '.png?v=1'), done, undefined, () => ok(white));
        else texLoader.load(`${base}tex/${name}.png?v=2`, (t) => { t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; done(t); }, undefined, () => ok(white));
      }));
    }
    return texs.get(name);
  }
  // 着色器里声明为 CLAMP 的采样器（flare 的 GradientMap、ubershadertwosided 的 MaskMap）：同一张图另建一份夹边的
  const clampTex = new Map();
  function clamped(t) {
    if (!t?.isTexture || t === white || t.isCubeTexture) return t;
    if (!clampTex.has(t)) { const c = t.clone(); c.wrapS = c.wrapT = THREE.ClampToEdgeWrapping; c.needsUpdate = true; clampTex.set(t, c); }
    return clampTex.get(t);
  }
  function geo(name) {
    if (!geos.has(name)) {
      geos.set(name, fetch(`${base}mesh/${name}.json?v=2`).then((r) => r.json()).then((d) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(d.n.length ? d.n : new Array(d.p.length).fill(0), 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv.length ? d.uv : new Array(d.p.length / 3 * 2).fill(0), 2));
        g.setIndex(d.i);
        return g;
      }).catch(() => null));
    }
    return geos.get(name);
  }
  // 特效定义：JSON + 全部网格 / 贴图就绪后才算可用
  function load(kind) {
    if (defs.has(kind)) return defs.get(kind);
    const d = { ok: false, json: null, geo: {}, tex: {} };
    defs.set(kind, d);
    fetch(`${base}${kind}.json?v=2`).then((r) => r.json()).then(async (j) => {
      const gs = new Set(), ts = new Set();
      JSON.stringify(j, (k, v) => { if (k === 'geo') gs.add(v); if (k === 'tex') ts.add(v); return v; });
      await Promise.all([...gs].map(async (n) => { d.geo[n] = await geo(n); }));
      const cubes = new Set(j.cubes || []);
      await Promise.all([...ts].map(async (n) => { d.tex[n] = await tex(n, cubes.has(n)); }));
      d.json = j.root;
      d.ok = true;
    }).catch(() => { d.ok = false; });
    return d;
  }

  // 实例：对象树深拷贝一份（曲线 / 绑定会改里面的值），解析 _ref，建网格
  function instantiate(d) {
    const root = structuredClone(d.json);
    const ids = new Map();
    const collect = (o) => { if (Array.isArray(o)) o.forEach(collect); else if (o && typeof o === 'object') { if (o._id != null) ids.set(o._id, o); Object.values(o).forEach(collect); } };
    collect(root);
    const resolve = (o) => {
      if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { const v = o[i]; if (v && v._ref != null) o[i] = ids.get(v._ref) || null; else resolve(v); } } else if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && v._ref != null) o[k] = ids.get(v._ref) || null; else resolve(v); }
      }
    };
    resolve(root);
    const inst = { root, meshes: [], sets: root.curveSets || [], seen: 0, t0: null };
    const curves = new Set();
    const visit = (o) => { if (Array.isArray(o)) o.forEach(visit); else if (o && typeof o === 'object') { if (/^Tr2CurveScalar/.test(o._type || '') && !curves.has(o)) { curves.add(o); o._rand = Math.random(); } Object.values(o).forEach(visit); } };
    visit(root);
    // 每个 Tr2Mesh 的每个区域一个 three 网格；材质的 uniform 直接引用参数对象，绑定改了值下一帧就生效
    const build = (node) => {
      if (!node || typeof node !== 'object') return;
      const mesh = node.mesh;
      if (mesh?.geo && d.geo[mesh.geo]) {
        for (const [list, blend] of [['opaqueAreas', 0], ['transparentAreas', 1], ['additiveAreas', 2]]) {
          for (const area of mesh[list] || []) {
            const fx = area.effect, kind = SHADER_OF[String(fx?.effectFilePath || '').split('/').pop().toLowerCase()];
            if (!kind) continue;
            const S = SHADERS[kind];
            const uniforms = { time, camF, DiffuseColor: { value: new THREE.Vector4(1, 1, 1, 1) }, Brightness: { value: 1 } };
            for (const n of ['TextureScroll1', 'TextureScroll2', 'TextureTransform1', 'TextureTransform2', 'FresnelFactors']) uniforms[n] = { value: new THREE.Vector4(n.startsWith('TextureTransform') ? 0 : 0, 0, n.startsWith('TextureTransform') ? 1 : 0, n.startsWith('TextureTransform') ? 1 : 0) };
            uniforms.ScaleAlongNormal = { value: new THREE.Vector3() };
            for (const n of ['DiffuseMap1', 'DiffuseMap2', 'MaskMap', 'GradientMap']) uniforms[n] = { value: white };
            uniforms.MainCubeMap = { value: null };
            for (const r of fx.resources || []) if (r.tex && d.tex[r.tex]) uniforms[r.name] = { value: S.clamp?.includes(r.name) ? clamped(d.tex[r.tex]) : d.tex[r.tex] };
            const params = [...(fx.constParameters || []), ...(fx.parameters || [])];
            const mat = new THREE.ShaderMaterial({
              uniforms, vertexShader: S.vs, fragmentShader: S.fs, side: S.side, depthWrite: blend === 0, transparent: blend > 0,
              blending: blend === 2 ? THREE.CustomBlending : blend === 1 ? THREE.NormalBlending : THREE.NoBlending,
              blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
            });
            const m = new THREE.Mesh(d.geo[mesh.geo], mat);
            m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 2; m.visible = false;
            scene.add(m);
            inst.meshes.push({ node, m, params, uniforms });
          }
        }
      }
      for (const c of node.children || []) build(c);
    };
    for (const k of ['sourceObject', 'destObject', 'stretchObject', 'moveObject']) build(root[k]);
    if (root._type === 'EveTransform') build(root);
    return inst;
  }

  // 节点世界矩阵（客户端坐标），按 Tr2Transform.UpdateViewDependentData
  const qA = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), mA = new THREE.Matrix4(), mB = new THREE.Matrix4();
  const V3 = (a, d = 0) => vA.set(a?.[0] ?? d, a?.[1] ?? d, a?.[2] ?? d);
  function transformNode(node, parent, ctx) {
    if (!node) return;
    // display 可能被曲线绑定写成 0 / 1
    if (node.display != null && !node.display) { hideTree(node); return; }
    if (node.hideOnLowQuality && ctx.lowQ) { hideTree(node); return; }
    const w = (node._w ||= new THREE.Matrix4());
    let s = node.scaling || [1, 1, 1];
    const r = node.rotation || [0, 0, 0, 1], t = node.translation || [0, 0, 0];
    const mod = node.modifier || 0;
    if (node.useDistanceBasedScale) {
      // 按镜头距离缩放：fovHeight = sin(视角 / 2) × 距离，缩放 × arg1 / fovHeight^arg2 × fovHeight
      const pos = vB.set(t[0], t[1], t[2]).applyMatrix4(parent);
      const fh = Math.sin(ctx.fov * 0.5) * pos.distanceTo(ctx.eye);
      const k = fh > 0 ? (node.distanceBasedScaleArg1 ?? 0) / Math.pow(fh, node.distanceBasedScaleArg2 ?? 0) * fh : 0;
      s = [s[0] * k, s[1] * k, s[2] * k];
    }
    if (mod === 100 || mod === 101 || mod === 102) {
      // EVE_CAMERA_ROTATION_ALIGNED：Z 轴指向镜头（换到父节点的基里算），X 轴取镜头右方向
      w.copy(parent).multiply(mA.makeTranslation(t[0], t[1], t[2]));
      const e = parent.elements;
      const dir = vB.set(ctx.eye.x - w.elements[12], ctx.eye.y - w.elements[13], ctx.eye.z - w.elements[14]);
      const intoBasis = (out, v) => out.set(v.x * e[0] + v.y * e[1] + v.z * e[2], v.x * e[4] + v.y * e[5] + v.z * e[6], v.x * e[8] + v.y * e[9] + v.z * e[10]);
      const fwd = intoBasis(vC, dir);
      fwd.x /= e[0] * e[0] + e[1] * e[1] + e[2] * e[2]; fwd.y /= e[4] * e[4] + e[5] * e[5] + e[6] * e[6]; fwd.z /= e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
      fwd.normalize();
      const right = intoBasis(vD, ctx.right);
      const up = vA.crossVectors(fwd, right).normalize();
      const bRight = vB.crossVectors(up, fwd);
      mA.makeBasis(bRight, up, fwd).multiply(mB.makeRotationFromQuaternion(qA.set(r[0], r[1], r[2], r[3])));
      w.multiply(mA).multiply(mB.makeScale(s[0], s[1], s[2]));
    } else {
      w.copy(parent).multiply(mA.compose(V3(t), qA.set(r[0], r[1], r[2], r[3]), vB.set(s[0], s[1], s[2])));
      if (mod === 1 || mod === 4) {
        // BILLBOARD（SIMPLE_HALO 另乘朝向系数，这里没有用到的特效，按公告板处理）：保留位置，三轴换成镜头的 右 / 上 / 后，缩放 = 自身 × 父节点各轴长度
        const e = parent.elements;
        const sx = s[0] * Math.hypot(e[0], e[1], e[2]), sy = s[1] * Math.hypot(e[4], e[5], e[6]), sz = s[2] * Math.hypot(e[8], e[9], e[10]);
        const pos = vB.setFromMatrixPosition(w);
        w.makeBasis(vC.copy(ctx.right).multiplyScalar(sx), vD.copy(ctx.up).multiplyScalar(sy), vA.copy(ctx.back).multiplyScalar(sz)).setPosition(pos);
      } else if (mod === 3) {
        // LOOK_AT_CAMERA：保留位置，X = −右、Y = 上、Z = 指向镜头；缩放 = 自身 × 父节点各轴长度
        const pos = vB.setFromMatrixPosition(w);
        const fwd = vC.copy(pos).sub(ctx.eye).normalize();
        const right = vD.crossVectors(vA.set(0, 1, 0), fwd).normalize();
        const up = vA.crossVectors(fwd, right).normalize();
        const e = parent.elements;
        const sx = s[0] * Math.hypot(e[0], e[1], e[2]), sy = s[1] * Math.hypot(e[4], e[5], e[6]), sz = s[2] * Math.hypot(e[8], e[9], e[10]);
        w.makeBasis(right.multiplyScalar(-sx), up.multiplyScalar(sy), fwd.multiplyScalar(-sz)).setPosition(pos);
      }
    }
    node._vis = true;
    for (const c of node.children || []) transformNode(c, w, ctx);
  }
  function hideTree(node) { node._vis = false; for (const c of node.children || []) hideTree(c); }

  // 客户端 StretchEffect 的端点：从船心朝对方船心走 包围盒半轴（×1.2，三轴都大于 10 米才算）组成的椭球半径
  function nearestBounds(out, from, to, ext, q) {
    const d = vD.copy(to).sub(from).normalize();
    let s = 0;
    if (ext && ext[0] > 10 && ext[1] > 10 && ext[2] > 10) {
      const l = vC.copy(d);
      if (q) l.applyQuaternion(qA.copy(q).invert());
      const [a, b, c] = ext;
      const den = Math.sqrt(l.x * l.x * b * b * c * c + l.y * l.y * a * a * c * c + l.z * l.z * a * a * b * b);
      if (den) s = Math.abs(a * b * c / den);
    }
    return out.copy(from).addScaledVector(d, s);
  }

  const live = new Map();
  const ID = new THREE.Matrix4();
  let frame = 0;
  const S1 = new THREE.Vector3(), S2 = new THREE.Vector3(), sv = new THREE.Vector3(), dv = new THREE.Vector3(), V0 = new THREE.Vector3(), FW = new THREE.Vector3(), Y1 = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1), SQ = new THREE.Vector3(), QS = new THREE.Quaternion(), mW = new THREE.Matrix4();
  const toEve = (out, p) => out.set(p.x / KM, p.y / KM, p.z / KM);
  const ctx = { eye: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3(), fov: 1, lowQ: false };

  return {
    // 这一类特效能不能用（JSON / 网格 / 贴图都到了）；第一次问时开始加载
    ready: (kind) => load(kind).ok,
    // 第一个曲线组（play_start）最长曲线的时长（秒）：timeScale 的特效按 时长 / 装备周期 拉伸（客户端 Start 里的 scaleValue）
    length(kind) {
      const d = load(kind);
      if (!d.ok) return 0;
      if (d.len == null) d.len = Math.max(0, ...(d.json.curveSets?.[0]?.curves || []).map((c) => { const K = c?.keys; return K?.length ? K[K.length - 1].time * (c.timeScale ?? 1) : 0; }));
      return d.len;
    },
    begin(camera, t, lowQ = false) {
      frame++;
      time.value = t;
      toEve(ctx.eye, camera.position);
      const r = vA.setFromMatrixColumn(camera.matrixWorld, 0);
      ctx.right.copy(r);
      r.setFromMatrixColumn(camera.matrixWorld, 1); ctx.up.copy(r);
      r.setFromMatrixColumn(camera.matrixWorld, 2); ctx.back.copy(r);
      ctx.fov = THREE.MathUtils.degToRad(camera.fov || 60);
      camera.getWorldDirection(camF.value);
      ctx.lowQ = lowQ;
    },
    // key：同一门装备固定一个实例（随机常数不变）；age：本周期开始了多久（秒）；scale：play_start 的时间倍率
    // o：{ src, dst（场景坐标）, srcExt, dstExt（包围盒半轴 ×1.2，米）, srcQ, dstQ（朝向）, R（目标半径，米） }
    play(kind, key, age, o, scale = 1) {
      const d = load(kind);
      if (!d.ok) return false;
      let inst = live.get(key);
      if (!inst || inst.kind !== kind) { if (inst) drop(key); inst = instantiate(d); inst.kind = kind; live.set(key, inst); }
      inst.seen = frame;
      if (inst.t0 == null) inst.t0 = time.value;
      const root = inst.root;
      // 曲线组：第一个（play_start）按本周期时间，其余 playOnLoad 的从实例创建起算
      inst.sets.forEach((set, n) => {
        if (!set) return;
        const sc = set.scale ?? 1;
        const st = n === 0 ? age * (scale ?? 1) * sc : (time.value - inst.t0) * sc;
        if (n !== 0 && set.playOnLoad === false) return;
        for (const c of set.curves || []) if (c) c.currentValue = curveAt(c, st);
        for (const b of set.bindings || []) if (b) copyBinding(b);
      });
      // 摆放
      if (root._type === 'EveStretch') {
        nearestBounds(S1, o.src, o.dst, o.srcExt && o.srcExt.map((x) => x * KM), o.srcQ);
        nearestBounds(S2, o.dst, o.src, o.dstExt && o.dstExt.map((x) => x * KM), o.dstQ);
        toEve(sv, S1); toEve(dv, S2);
        const len = sv.distanceTo(dv);
        if (root.length) root.length.value = len;
        // 这里用专用的临时变量：transformNode 内部会改 vA~vD / qA
        const v0 = V0.copy(sv).sub(dv).normalize();
        QS.setFromUnitVectors(Y1, v0);
        if (root.sourceObject) transformNode(root.sourceObject, mW.compose(sv, QS, ONE), ctx);
        if (root.destObject) transformNode(root.destObject, mW.compose(dv, QS, ONE), ctx);
        if (root.stretchObject) {
          // quat.arcFromForward：把 −Z 转到 源→目标 方向
          const f = FW.copy(v0).negate();
          if (f.z < 0.99999) { const rt = Math.sqrt(1 - f.z), dv2 = 0.707106781187 / rt; QS.set(f.y * dv2, -f.x * dv2, 0, 0.707106781187 * rt); } else QS.set(1, 0, 0, 0);
          transformNode(root.stretchObject, mW.compose(sv, QS, SQ.set(1, 1, len)), ctx);
        }
      } else {
        // ShipEffect：放在目标船位置，按目标半径缩放（transformFlags 未知，见说明）；o.rot = 跟船转（FX_TF_ROTATION_BALL）
        // o.dir：朝向 = 从 (0,0,1) 转到这个方向；o.S：三轴缩放 [x, y, z]
        toEve(dv, o.dst);
        if (o.dir) QS.setFromUnitVectors(FW.set(0, 0, 1), V0.copy(o.dir).normalize());
        else if (o.rot) QS.copy(o.rot); else QS.identity();
        if (o.S) SQ.set(o.S[0], o.S[1], o.S[2]); else SQ.setScalar(o.R || 1);
        transformNode(root, mW.compose(dv, QS, SQ), ctx);
      }
      for (const x of inst.meshes) {
        x.m.visible = !!x.node._vis;
        if (!x.m.visible) continue;
        x.m.matrix.multiplyMatrices(TO_SCENE, x.node._w || ID);
        for (const p of x.params) {
          const u = x.uniforms[p.name], v = p.value;
          if (!u) continue;
          if (u.value?.isVector4 && Array.isArray(v)) u.value.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
          else if (u.value?.isVector3 && Array.isArray(v)) u.value.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
          else if (typeof v === 'number') u.value = v;
        }
      }
      return true;
    },
    // 这一帧没播的实例藏起来，久不用的释放
    end() {
      for (const [key, inst] of live) {
        if (inst.seen === frame) continue;
        for (const x of inst.meshes) x.m.visible = false;
        if (frame - inst.seen > 600) drop(key);
      }
    },
    dispose() { for (const k of [...live.keys()]) drop(k); },
  };
  function drop(key) {
    const inst = live.get(key);
    if (!inst) return;
    for (const x of inst.meshes) { scene.remove(x.m); x.m.material.dispose(); }
    live.delete(key);
  }
}
