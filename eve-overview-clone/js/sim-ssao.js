// 屏幕空间环境光遮蔽：照客户端 Tr2SSAO（AMD FidelityFX CACAO，画质「最高」、原生分辨率、2 遍模糊）的算法自己实现。
//   实机抓帧里的常量：半径 6 米、强度 1×4.3、幂 2.6、上限 0.98、锐度 0.5（InvSharpness 0.5）、细节 AO 5、
//   淡出 z 1→10 米（FadeOutMul 1/9，Add −1/9）、地平线阈值 0.06、近处半径限制 = 半径×1.2/tan(半垂直视角)。
// 和客户端的差别（WebGL 没有计算着色器）：
//   · 不真的拆成 4 张半分辨率图：全分辨率里按像素奇偶分 4 组，组内邻居隔 2 个像素，采样点、旋转矩阵、边缘、模糊、合成都按 CACAO 的拆分坐标算；
//   · 用「高」档的固定 12 对采样，不做「最高」档的自适应采样（重要度图 + 加样）；不做深度 mip（采样都读第 0 级）；
//   · 法线用几何法线（客户端读 G-buffer 里的贴图法线）。
// 只有船 / 炮塔 / 无人机（图层 SSAO_LAYER）写进深度缓冲，结果只给船壳材质用（最终颜色 = 光照 × AO，再加发光）。
import * as THREE from './vendor/three/three.module.min.js';

export const SSAO_LAYER = 5;
// 船壳材质读这两个（sim-ships.js）
export const SHIP_AO = { tex: { value: null }, on: { value: 0 } };

const C = { radius: 6, strength: 4.3, pow: 2.6, clamp: 0.98, horizon: 0.06, invSharp: 0.5, detail: 5, fadeMul: 1 / 9, fadeAdd: -1 / 9, precision: 0.9992 };

// CACAO g_FFX_CACAO_samplePatternMain 前 12 个（xy 偏移、z 权重；w = log2 长度只给深度 mip 用）
const PATTERN = [
  [0.78488064, 0.56661671, 1.5], [0.26022232, -0.29575172, 1.5], [0.10459357, 0.08372527, 1.11], [-0.682868, 0.04963045, 1.09],
  [-0.13570161, -0.64190155, 1.25], [-0.26193795, -0.08205118, 0.67], [-0.61177456, 0.66664219, 0.71], [0.43675563, 0.25119025, 0.61],
  [0.07884444, 0.86618668, 0.64], [-0.12790935, -0.29869005, 0.6], [-0.04031125, 0.02413622, 0.6], [0.16201244, -0.52851415, 0.79],
];

// 每组（pass）5 个旋转缩放矩阵（UpdatePerPassConstants）
function rotScale() {
  const out = [];
  const spmap = [0, 1, 4, 3, 2];
  for (let a = 0; a < 4; a++) for (let sub = 0; sub < 5; sub++) {
    const b = spmap[sub];
    const ang = (a + b / 5) * Math.PI * 0.5, ca = Math.cos(ang), sa = Math.sin(ang);
    const s = 1 + (a - 1.5 + (b - 2) / 5) * 0.07;
    out.push(new THREE.Vector4(s * ca, -s * sa, -s * sa, -s * ca));
  }
  return out;
}

// 像素坐标统一用 D3D 习惯（y 向下），取数时翻回 GL 行号；观察空间 = CACAO 的 x 右、y 上、z 朝前（米）
const COMMON = `precision highp float; precision highp int;
  uniform ivec2 uSize;
  ivec2 dPix() { return ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y)); }
  vec4 at(highp sampler2D t, ivec2 p) { p = clamp(p, ivec2(0), uSize - 1); return texelFetch(t, ivec2(p.x, uSize.y - 1 - p.y), 0); }
  float sat(float x) { return clamp(x, 0.0, 1.0); }
  vec4 sat(vec4 x) { return clamp(x, 0.0, 1.0); }
  uniform float uInvSharp;
  float packEdges(vec4 e) { e = floor(sat(e) * 3.05 + 0.5); return dot(e, vec4(64.0, 16.0, 4.0, 1.0) / 255.0); }
  vec4 unpackEdges(float v) {
    int p = int(v * 255.5);
    return sat(vec4(float((p >> 6) & 3), float((p >> 4) & 3), float((p >> 2) & 3), float(p & 3)) / 3.0 + uInvSharp);
  }
  out vec4 color;`;

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';

const GEN = `${COMMON}
  uniform highp sampler2D uDN;        // rgb = 观察空间法线（CACAO 习惯），a = 深度（米，0 = 没东西）
  uniform vec2 uTan;                  // tan(半水平视角), tan(半垂直视角)
  uniform vec4 uRS[20];
  uniform float uNearRec;
  const vec3 PAT[12] = vec3[12](${PATTERN.map((p) => `vec3(${p.join(', ')})`).join(', ')});
  ivec2 P0; ivec2 DD; vec2 NDCMul, NDCAdd;
  // 拆分坐标 s（这一组里的第几个像素）→ 全分辨率像素
  float Z(ivec2 s) { float z = at(uDN, s * 2 + P0).a; return z > 0.0 ? z : 1e9; }
  vec3 N(ivec2 s) { return at(uDN, s * 2 + P0).rgb; }
  vec3 viewPos(vec2 uv, float z) { return vec3((NDCMul * uv + NDCAdd) * z, z); }
  float obsc(vec3 n, vec3 d, float fall) {
    float l2 = dot(d, d);
    return max(0.0, dot(n, d) * inversesqrt(l2) - ${C.horizon.toFixed(4)}) * max(0.0, l2 * fall + 1.0);
  }
  void main() {
    ivec2 p = dPix();
    P0 = p & 1; ivec2 s = p >> 1; int pass = P0.x + P0.y * 2;
    DD = (uSize + 1) / 2;
    vec2 inv = 1.0 / vec2(DD);
    NDCMul = vec2(uTan.x * 2.0, uTan.y * -2.0); NDCAdd = vec2(-uTan.x, uTan.y);
    float pixZ = Z(s);
    if (pixZ > 1e8) { color = vec4(1.0, packEdges(vec4(1.0)), 0.0, 1.0); return; }
    float pixLZ = Z(s + ivec2(-1, 0)), pixRZ = Z(s + ivec2(1, 0)), pixTZ = Z(s + ivec2(0, -1)), pixBZ = Z(s + ivec2(0, 1));
    vec2 uv = (vec2(s) + 0.5) * inv;
    vec3 c = viewPos(uv, pixZ);
    vec3 n = N(s);
    vec2 pxView = c.z * NDCMul * inv;
    // 半径参数（太近时缩小，免得采样盘超出屏幕）
    float rad = ${C.radius.toFixed(1)} * (sat(length(c) * uNearRec) * 0.8 + 0.2);
    float lookup = 0.85 * rad / pxView.x;
    float fall = -1.0 / (rad * rad);
    vec4 rs = uRS[pass * 5 + (s.y * 2 + s.x) % 5] * lookup;
    mat2 R = mat2(rs.x, rs.z, rs.y, rs.w);   // HLSL float2x2(x, y, z, w) 按行
    float oSum = 0.0, wSum = 0.0;
    c *= ${C.precision};
    // 深度边缘（坡度修正）
    vec4 e = vec4(pixLZ, pixRZ, pixTZ, pixBZ) - c.z;
    e = min(abs(e), abs(e + e.yxwz));
    vec4 edges = sat(1.3 - e / (c.z * 0.04));
    // 细节 AO：上下左右四个邻居（衰减 ×4）
    vec3 dirZ = vec3(c.xy / c.z, 1.0);
    vec4 add = vec4(
      obsc(n, vec3(-pxView.x, 0.0, 0.0) + dirZ * (pixLZ - c.z), 4.0 * fall),
      obsc(n, vec3(pxView.x, 0.0, 0.0) + dirZ * (pixRZ - c.z), 4.0 * fall),
      obsc(n, vec3(0.0, -pxView.y, 0.0) + dirZ * (pixTZ - c.z), 4.0 * fall),
      obsc(n, vec3(0.0, pxView.y, 0.0) + dirZ * (pixBZ - c.z), 4.0 * fall));
    oSum += ${C.detail.toFixed(1)} * dot(add, edges);
    // 法线边缘
    edges *= sat(vec4(dot(n, N(s + ivec2(-1, 0))), dot(n, N(s + ivec2(1, 0))), dot(n, N(s + ivec2(0, -1))), dot(n, N(s + ivec2(0, 1)))) + 0.5);
    for (int i = 0; i < 12; i++) {
      vec2 off = floor(R * PAT[i].xy + 0.5);
      for (int k = 0; k < 2; k++) {
        ivec2 t = s + ivec2(k == 0 ? off : -off);
        vec3 d = viewPos((vec2(t) + 0.5) * inv, Z(t)) - c;
        float o = obsc(n, d, fall);
        float w = (0.6 * sat(max(0.0, -d.z) * ${(-1 / C.radius).toFixed(6)} + 2.0) + 0.4) * PAT[i].z;
        oSum += o * w; wSum += w;
      }
    }
    float ob = oSum / wSum;
    float fade = sat(c.z * ${C.fadeMul.toFixed(6)} + ${C.fadeAdd.toFixed(6)});
    fade *= sat(1.0 - (sat((1.0 - edges.x - edges.y) * 0.35) + sat((1.0 - edges.z - edges.w) * 0.35)));
    ob = min(${C.strength.toFixed(2)} * ob, ${C.clamp.toFixed(2)}) * fade;
    color = vec4(pow(sat(1.0 - ob), ${C.pow.toFixed(2)}), packEdges(edges), 0.0, 1.0);
  }`;

// 边缘敏感模糊：同组上下左右（全分辨率隔 2 像素），中心权重 0.5，邻居权重 = 中心的边缘值
const BLUR = `${COMMON}
  uniform highp sampler2D uSrc;
  void main() {
    ivec2 p = dPix();
    vec4 cv = at(uSrc, p);
    vec4 e = unpackEdges(cv.g);
    float sum = cv.r * 0.5 + at(uSrc, p + ivec2(-2, 0)).r * e.x + at(uSrc, p + ivec2(2, 0)).r * e.y + at(uSrc, p + ivec2(0, -2)).r * e.z + at(uSrc, p + ivec2(0, 2)).r * e.w;
    color = vec4(sum / (0.5 + e.x + e.y + e.z + e.w), cv.g, 0.0, 1.0);
  }`;

// 合成（FFX_CACAO_Apply）：本组的值 + 横 / 竖 / 斜三组在拆分坐标里双线性取样，靠边时往像素中心收、并降权
const APPLY = `${COMMON}
  uniform highp sampler2D uSrc;
  float passAt(ivec2 s, ivec2 o) { return at(uSrc, s * 2 + o).r; }
  float bilin(vec2 d, ivec2 o) {   // d：拆分坐标（像素中心在 +0.5）
    vec2 f = d - 0.5, i0 = floor(f), t = f - i0;
    ivec2 b = ivec2(i0);
    ivec2 DD = (uSize + 1) / 2 - 1;
    float a = passAt(clamp(b, ivec2(0), DD), o), bb = passAt(clamp(b + ivec2(1, 0), ivec2(0), DD), o);
    float cc = passAt(clamp(b + ivec2(0, 1), ivec2(0), DD), o), dd = passAt(clamp(b + ivec2(1, 1), ivec2(0), DD), o);
    return mix(mix(a, bb, t.x), mix(cc, dd, t.x), t.y);
  }
  void main() {
    ivec2 p = dPix();
    int mx = p.x & 1, my = p.y & 1;
    vec4 cv = at(uSrc, p);
    vec4 e = unpackEdges(cv.g);
    float fmx = float(mx), fmy = float(my), fmxe = e.y - e.x, fmye = e.w - e.z;
    vec2 ip = vec2(p);
    float aoH = bilin((ip + vec2(fmx + fmxe - 0.5, 0.5 - fmy)) * 0.5, ivec2(1 - mx, my));
    float aoV = bilin((ip + vec2(0.5 - fmx, fmy - 0.5 + fmye)) * 0.5, ivec2(mx, 1 - my));
    float aoD = bilin((ip + vec2(fmx - 0.5 + fmxe, fmy - 0.5 + fmye)) * 0.5, ivec2(1 - mx, 1 - my));
    vec4 w = vec4(1.0, (e.x + e.y) * 0.5, (e.z + e.w) * 0.5, 0.0);
    w.w = (w.y + w.z) * 0.5;
    color = vec4(vec3(dot(vec4(cv.r, aoH, aoV, aoD), w) / dot(w, vec4(1.0))), 1.0);
  }`;

// 深度 + 法线预渲染（实例化、对数深度都走 three 自带的块）
const PRE_VS = `#include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vN; varying float vZ;
  void main() {
    #include <beginnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <project_vertex>
    vN = transformedNormal; vZ = -mvPosition.z;
    #include <logdepthbuf_vertex>
  }`;
const PRE_FS = `#include <logdepthbuf_pars_fragment>
  varying vec3 vN; varying float vZ;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    gl_FragColor = vec4(n.x, n.y, -n.z, vZ * 1000.0);   // 世界单位是千米 → 米；z 翻成朝前
  }`;

export function createSSAO(renderer) {
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  const rtF = (o) => new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false, ...o });
  const pre = rtF({ type: THREE.FloatType, depthBuffer: true });
  const a = rtF({ type: THREE.HalfFloatType }), b = rtF({ type: THREE.HalfFloatType }), out = rtF({ type: THREE.HalfFloatType });
  const size = { value: new THREE.Vector2() };
  const shader = (fs, uniforms) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false,
    uniforms: { uSize: { value: [1, 1] }, uInvSharp: { value: C.invSharp }, ...uniforms } });
  const gen = shader(GEN, { uDN: { value: pre.texture }, uTan: { value: new THREE.Vector2() }, uRS: { value: rotScale() }, uNearRec: { value: 0 } });
  const blur = shader(BLUR, { uSrc: { value: null } });
  const apply = shader(APPLY, { uSrc: { value: b.texture } });
  const preMat = new THREE.ShaderMaterial({ vertexShader: PRE_VS, fragmentShader: PRE_FS });
  const qs = new THREE.Scene(), qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gen);
  quad.frustumCulled = false; qs.add(quad);
  const draw = (m, t) => { quad.material = m; renderer.setRenderTarget(t); renderer.render(qs, qc); };
  const cc = new THREE.Color();
  let sz = '';
  return {
    // 主渲染前调用：w、h = 主场景缓冲的像素尺寸
    run(scene, camera, w, h) {
      if (`${w}x${h}` !== sz) { sz = `${w}x${h}`; for (const t of [pre, a, b, out]) t.setSize(w, h); }
      for (const m of [gen, blur, apply]) m.uniforms.uSize.value = [w, h];
      const ty = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
      gen.uniforms.uTan.value.set(ty * camera.aspect, ty);
      gen.uniforms.uNearRec.value = ty / (C.radius * 1.2);
      // 预渲染：只画 SSAO 图层，不更新阴影，背景清成 0
      const layers = camera.layers.mask, bg = scene.background, ov = scene.overrideMaterial, au = renderer.shadowMap.autoUpdate, ca = renderer.getClearAlpha();
      renderer.getClearColor(cc);
      camera.layers.set(SSAO_LAYER); scene.background = null; scene.overrideMaterial = preMat; renderer.shadowMap.autoUpdate = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(pre); renderer.clear(); renderer.render(scene, camera);
      camera.layers.mask = layers; scene.background = bg; scene.overrideMaterial = ov; renderer.shadowMap.autoUpdate = au;
      renderer.setClearColor(cc, ca);
      draw(gen, a);
      blur.uniforms.uSrc.value = a.texture; draw(blur, b);
      blur.uniforms.uSrc.value = b.texture; draw(blur, a);
      apply.uniforms.uSrc.value = a.texture; draw(apply, out);
      SHIP_AO.tex.value = out.texture; SHIP_AO.on.value = 1;
    },
    off() { SHIP_AO.on.value = 0; },
    dispose() { for (const t of [pre, a, b, out]) t.dispose(); for (const m of [gen, blur, apply, preMat]) m.dispose(); SHIP_AO.on.value = 0; },
  };
}
