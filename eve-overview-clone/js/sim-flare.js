// ===== 驾驶模拟的恒星镜头光晕（客户端 EveLensflare）=====
// 数据：tools/ship-models/lensflare.mjs 从 fisfx/lensflare/*.black + .gr2 转出的 assets/eveui/fx/lensflare/<名>.json + tex/*.png。
// 哪个光晕：客户端 sun.py 用 cfg.mapSystemCache[星系].sunFlareGraphicID（res:/staticdata/systems.static）；
//   驾驶模拟的四个星系查出来：艾玛、帕多尔 1243 orange_sun，新加达里 1244 pink_sun_small，泛光之源 1245 orange_radiating。
//   这里按恒星 typeID 查（四个星系里恒星类型和光晕一一对应）；别的恒星类型没有数据，不画。
// 每层（mesh 的 additiveAreas，lensflare.fx）：顶点、像素着色器照 lensflare.sm_hi 的反汇编翻译（常量缓冲布局取自 .sm_hi 包装段）：
//   VS cb0：Scale(xyzw)、CenterShift、Shift(xy)、Size(xy)、Rotation、RotationToCenter、Skew、FlareDepth、MinShaderModel；
//   PS cb0：Color、Intensity(xyzw)、ViewAngleStrength(xy)；
//   每帧（EveSpaceScenePerFrameVSData）：ViewProjection（太阳方向 w = 0 投影到屏幕）、ViewInverse 第 3 行（镜头轴）、
//   TargetResolution + FovXY（cb1[43]：按长边定方、乘 0.8 ÷ 竖直视场角）；每物体：方向、sunSize、遮挡缓冲的两个槽。
// CPU 部分照 EveLensflare::PrepareRender / Update：太阳屏幕位置 → distanceToEdge / Center / radialAngle / x、y 曲线 → bindings 写进各层参数；
//   sunSize = 1.5 ÷ ln(距离 AU + 2.71)。
// 遮挡（客户端 EveOccluder + Tr2OcclusionBuffer）：前景、背景各两个精灵（zsprite 0.5 × 缩放 50 / 15，沿太阳方向 900 米、镜头前 20 米，
//   按 cos² × sunSize 缩放），统计精灵 hringur 贴图 alpha > 0.5 的像素里「深度为空」的比例，两个相乘；全在屏幕外时保留上次的值。
//   这里的做法（简化）：用对准精灵的窄视场镜头把整个场景画进 64 × 64 深度贴图，再在一个像素里数；
//   前景 / 背景两个场景合在一起画的，按天体数据把落在行星、卫星圆盘里的像素算作背景遮挡、其余有深度的算前景遮挡。
// 渲染：场景之后、泛光 / 色调映射之前加色叠加进场景缓冲（低画质没有后处理时直接叠到屏幕上）。
// 版权归 CCP，仅供本站驾驶模拟画面使用。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const AU = 0.1495978707e12;
const FLARE_OF_SUN = { 45037: 'orange_sun', 3799: 'pink_sun_small', 3800: 'orange_radiating' };
const OCC_N = 64;        // 遮挡测试的分辨率（客户端是在全屏深度上画精灵）
const MAX_PL = 16;       // 参与背景遮挡的行星 / 卫星数（取角半径最大的）
const PARAMS = { Scale: 4, CenterShift: 1, Shift: 2, Size: 2, Rotation: 1, RotationToCenter: 1, Skew: 1, FlareDepth: 1, MinShaderModel: 1, Color: 4, Intensity: 4, ViewAngleStrength: 2 };

const VS = `uniform mat4 uVP; uniform vec3 uSun, uFwd; uniform vec4 uRes; uniform float uSunSize; uniform sampler2D uOcc;
  uniform vec4 Scale; uniform float CenterShift, Rotation, RotationToCenter, Skew, FlareDepth, MinShaderModel; uniform vec2 Shift, Size;
  varying vec4 vT;
  void main() {
    vec4 c = uVP * vec4(uSun, 0.0);
    vec2 s = c.xy / c.w;
    vec2 p = s - s * CenterShift + Shift;
    float py = (p.x == 0.0 && p.y == 0.0) ? 0.0001 : p.y;
    float ang = atan(p.x, py) * RotationToCenter + Rotation;
    float sn = sin(ang), cs = cos(ang);
    vec2 v = position.xy * Size;
    vec2 q = vec2(v.x * cs + v.y * sn, -v.x * sn + v.y * cs);
    vec2 n = vec2(p.x, py) * inversesqrt(p.x * p.x + py * py);
    float a = dot(q, n), b = q.y * n.x - q.x * n.y;
    b *= (a + 0.707107) * Skew + 1.0;
    vec2 o = vec2(a * n.x - b * n.y, a * n.y + b * n.x);
    o = uRes.x < uRes.y ? vec2(o.x * uRes.y / uRes.x, o.y) : vec2(o.x, o.y * uRes.x / uRes.y);
    o *= 0.8 / uRes.w;
    float cv = dot(uFwd, uSun);
    vec4 occ = texture2D(uOcc, vec2(0.5));
    float fg = occ.r * occ.g, bg = occ.b * occ.a;
    float k = (Scale.z * (cv * cv - 1.0) + 1.0) * (Scale.y * (uSunSize - 1.0) + 1.0);
    k *= (Scale.w * (fg - 1.0) + 1.0) * Scale.x * bg;
    p += o * k;
    float w = clamp(2.0 - MinShaderModel, 0.0, 1.0);
    gl_Position = vec4(p * w, (2.0 * FlareDepth - 1.0) * w, w);
    vT = vec4(uv, cv, fg);
  }`;
const FS = `uniform sampler2D TexMap, ModulationTexMap; uniform vec4 Color, Intensity; uniform vec2 ViewAngleStrength;
  varying vec4 vT;
  float P(float x, float e) { return e == 0.0 ? 1.0 : pow(max(abs(x), 0.0), e); }
  void main() {
    vec4 t = texture2D(TexMap, vT.xy) * Color;
    t *= P(vT.z, ViewAngleStrength.x) * P(1.0 - vT.z, ViewAngleStrength.y) * Intensity.z;
    t *= (texture2D(ModulationTexMap, vT.xy) - 1.0) * clamp(Intensity.y, 0.0, 1.0) + 1.0;
    t *= Intensity.x * (Intensity.w * (vT.w - 1.0) + 1.0);
    gl_FragColor = t;
  }`;
// 遮挡计数（Tr2OcclusionBuffer 的 CopyCounters：每个精灵 = 可见像素 ÷ 总像素，总数为 0 时保留上次）
const OCC_FS = `precision highp float; precision highp int;
  uniform highp sampler2D uDepth, uMask, uPrev; uniform mat3 uRot; uniform mat4 uVP; uniform float uTan, uRatio; uniform vec4 uPl[${MAX_PL}]; uniform int uNp;
  out vec4 color;
  void main() {
    float tb = 0.0, fb = 0.0, bb = 0.0, ts = 0.0, fs = 0.0, bs = 0.0;
    for (int j = 0; j < ${OCC_N}; j++) for (int i = 0; i < ${OCC_N}; i++) {
      vec2 nd = (vec2(float(i), float(j)) + 0.5) / ${OCC_N}.0 * 2.0 - 1.0;
      vec3 d = normalize(uRot * vec3(nd * uTan, -1.0));
      vec4 c = uVP * vec4(d, 0.0);
      if (c.w <= 0.0 || abs(c.x) > c.w || abs(c.y) > c.w) continue;   // 屏幕外的像素不计
      bool pl = false;
      for (int k = 0; k < ${MAX_PL}; k++) { if (k >= uNp) break; if (dot(d, uPl[k].xyz) > uPl[k].w) pl = true; }
      bool cov = texelFetch(uDepth, ivec2(i, j), 0).r < 1.0;
      float fv = (cov && !pl) ? 0.0 : 1.0, bv = pl ? 0.0 : 1.0;
      if (textureLod(uMask, nd * 0.5 + 0.5, 0.0).a > 0.5) { tb += 1.0; fb += fv; bb += bv; }
      vec2 us = nd * uRatio * 0.5 + 0.5;
      if (us.x >= 0.0 && us.y >= 0.0 && us.x <= 1.0 && us.y <= 1.0 && textureLod(uMask, us, 0.0).a > 0.5) { ts += 1.0; fs += fv; bs += bv; }
    }
    vec4 p = texelFetch(uPrev, ivec2(0), 0);
    color = vec4(tb > 0.0 ? fb / tb : p.r, ts > 0.0 ? fs / ts : p.g, tb > 0.0 ? bb / tb : p.b, ts > 0.0 ? bs / ts : p.a);
  }`;

// 曲线（Tr2CurveScalar：按左键的插值方式，0 常数 / 1 线性 / 2 Hermite；两端夹住）
function curveAt(keys, t) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  const L = keys[keys.length - 1];
  if (t >= L[0]) return L[1];
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1][0]) i++;
  const [t0, v0, it, , rt] = keys[i], [t1, v1, , lt] = keys[i + 1], len = t1 - t0;
  if (it === 0) return t === t1 ? v1 : v0;
  if (len === 0) return v1;
  const s = (t - t0) / len;
  if (it === 1) return v0 + (v1 - v0) * s;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * rt * len + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * lt * len;
}

// renderer、scene、camera：sim-3d 的；base：光晕数据目录（…/fx/lensflare/）
export function createFlare(renderer, scene, camera, base) {
  const loader = new THREE.TextureLoader();
  const texCache = new Map(), dataCache = new Map();
  const tex = (name) => {
    if (!texCache.has(name)) {
      const t = loader.load(`${base}tex/${name}.png?v=1`);
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      texCache.set(name, t);
    }
    return texCache.get(name);
  };
  const fscene = new THREE.Scene();
  let cur = null, want = null, cel = [], frame = 0;
  const shared = { uVP: { value: new THREE.Matrix4() }, uSun: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector4(1, 1, 1, 1) }, uSunSize: { value: 1 }, uOcc: { value: null } };

  // 遮挡：窄视场深度 → 1 × 1 结果（前后两帧来回读写）
  const occCam = new THREE.PerspectiveCamera(1, 1, camera.near, camera.far);
  const occRT = new THREE.WebGLRenderTarget(OCC_N, OCC_N, { depthBuffer: true, depthTexture: new THREE.DepthTexture(OCC_N, OCC_N, THREE.UnsignedIntType), generateMipmaps: false });
  const res = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false }));
  let ri = 0, primed = false;
  const occMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uDepth: { value: occRT.depthTexture }, uMask: { value: null }, uPrev: { value: null }, uRot: { value: new THREE.Matrix3() }, uVP: shared.uVP, uTan: { value: 0.01 }, uRatio: { value: 1 },
      uPl: { value: Array.from({ length: MAX_PL }, () => new THREE.Vector4()) }, uNp: { value: 0 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: OCC_FS, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), occMat);
  quad.frustumCulled = false;
  const qs = new THREE.Scene(); qs.add(quad);
  const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function clearOcc() {   // Tr2OcclusionBuffer 的 Clear：结果都置 1
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), rt = renderer.getRenderTarget();
    renderer.setClearColor(0xffffff, 1);
    for (const r of res) { renderer.setRenderTarget(r); renderer.clear(true, false, false); }
    renderer.setClearColor(cc, ca); renderer.setRenderTarget(rt);
    primed = true;
  }

  const wipe = () => { fscene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); fscene.clear(); };
  function build(d) {
    wipe();
    const layers = [];
    for (const L of d.layers) {
      const [i0, cnt] = d.mesh.areas[L.area] || [0, 0];
      if (!cnt) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.mesh.p.flatMap((x, k) => (k % 2 ? [x, 0] : [x])), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(d.mesh.uv, 2));
      g.setIndex(d.mesh.i.slice(i0, i0 + cnt));
      const u = { ...shared, TexMap: { value: tex(L.tex || 'white') }, ModulationTexMap: { value: tex(L.mod || 'white') } };
      for (const [k, n] of Object.entries(PARAMS)) {
        const v = L.p[k] || [0, 0, 0, 0];
        u[k] = { value: n === 1 ? v[0] : n === 2 ? new THREE.Vector2(v[0], v[1]) : new THREE.Vector4(v[0], v[1], v[2], v[3]) };
      }
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms: u, vertexShader: VS, fragmentShader: FS, transparent: true, side: THREE.DoubleSide, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,   // gr2 是 D3D 的顺时针绕序：两面都画
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      m.frustumCulled = false;
      fscene.add(m);
      layers.push({ L, u });
    }
    // bindings：曲线（_id）→ 某层参数（_id）的某个分量
    const curves = new Map();
    for (const [kind, list] of Object.entries(d.curves)) for (const c of list) curves.set(c.id, { kind, keys: c.keys, v: 0 });
    const binds = [];
    for (const b of d.bindings) {
      const c = curves.get(b.src);
      const ly = layers.find((x) => Object.values(x.L.ids).includes(b.dst));
      if (!c || !ly) continue;   // 镜头污渍（lensgrime）的绑定：那一层没画
      const pname = Object.entries(ly.L.ids).find(([, id]) => id === b.dst)[0];
      binds.push({ c, u: ly.u[pname], comp: b.comp });
    }
    const big = d.occluders[0], small = d.occluders[1] || big;
    return { d, curves: [...curves.values()], binds, occ: big ? { big: big.scale[0] * d.sprite, small: small.scale[0] * d.sprite, z: -big.z, tex: tex(d.occTex) } : null };
  }
  function load(name) {
    if (!dataCache.has(name)) dataCache.set(name, fetch(`${base}${name}.json?v=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    dataCache.get(name).then((d) => { if (want === name && d) { cur = build(d); clearOcc(); } });
  }
  // cel：rec.cel（天体，米）
  function set(list) {
    cel = list || [];
    const s = cel.find((c) => c.group === 6);
    const name = s ? FLARE_OF_SUN[s.type] || null : null;
    want = name; cur = null; wipe();
    if (name) load(name);
  }

  const v4 = new THREE.Vector4(), cam = new THREE.Vector3(), toSun = new THREE.Vector3(), fwd = new THREE.Vector3(), dv = new THREE.Vector3(), tmp = new THREE.Vector3(), up = new THREE.Vector3();
  const size = new THREE.Vector2();
  let visible = false;
  // 每帧（镜头抖动之后、渲染之前）：ORG 浮动原点（米）；low：低画质（遮挡隔帧算）
  function update(ORG, low) {
    visible = false;
    if (!cur) return;
    const sun = cel.find((c) => c.group === 6);
    if (!sun) return;
    camera.updateMatrixWorld();
    cam.set(camera.position.x / KM + ORG[0], camera.position.y / KM + ORG[1], camera.position.z / KM + ORG[2]);
    toSun.set(sun.pos[0] - cam.x, sun.pos[1] - cam.y, sun.pos[2] - cam.z);
    const dist = toSun.length();
    toSun.normalize();
    camera.getWorldDirection(fwd);
    // UpdateVisibility：镜头朝向和太阳方向点积 ≥ 0
    if (fwd.dot(toSun) < 0) return;
    visible = true;
    shared.uVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    shared.uSun.value.copy(toSun); shared.uFwd.value.copy(fwd);
    renderer.getDrawingBufferSize(size);
    shared.uRes.value.set(size.x, size.y, THREE.MathUtils.degToRad(camera.fov) * camera.aspect, THREE.MathUtils.degToRad(camera.fov));
    shared.uSunSize.value = 1.5 / Math.log(dist / AU + 2.71);
    // PrepareRender：太阳的屏幕位置驱动各条曲线，再由 bindings 写进参数
    v4.set(toSun.x, toSun.y, toSun.z, 0).applyMatrix4(shared.uVP.value);
    const x = v4.x / v4.w, y = v4.y / v4.w;
    const at = { edge: 1 - Math.min(1 - Math.abs(x), 1 - Math.abs(y)), center: Math.hypot(x, y), angle: Math.atan2(y, x) + Math.PI, x: x + 10, y: y + 10 };
    for (const c of cur.curves) c.v = curveAt(c.keys, at[c.kind]);
    for (const b of cur.binds) { if (typeof b.u.value === 'number') b.u.value = b.c.v; else b.u.value[b.comp] = b.c.v; }
    // 遮挡
    if (!cur.occ) return;
    if (!primed) clearOcc();
    shared.uOcc.value = res[ri].texture;
    if (low && frame++ % 4) return;
    const cv = fwd.dot(toSun), k = cv * cv * shared.uSunSize.value;
    dv.copy(fwd).multiplyScalar(cur.d.cameraFactor).addScaledVector(toSun, cur.occ.z);   // 精灵中心：镜头前 cameraFactor 米、再朝太阳 900 米
    const R = Math.max(cur.occ.big * k, 1e-6), tan = R / dv.length();
    // 精灵外接圆整个在屏幕外：客户端没有像素参与计数，结果不变
    const m = 1 + 2 * tan / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    if (Math.abs(x) > m * Math.max(1, camera.aspect) || Math.abs(y) > m * Math.max(1, 1 / camera.aspect)) return;
    occCam.near = camera.near; occCam.far = camera.far; occCam.aspect = 1;
    occCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tan));
    occCam.updateProjectionMatrix();
    occCam.position.copy(camera.position);
    occCam.up.copy(up.set(0, 1, 0).applyQuaternion(camera.quaternion));   // 精灵跟随镜头旋转（modifier 103）
    occCam.lookAt(tmp.copy(camera.position).add(dv));
    occCam.updateMatrixWorld();
    // 行星、卫星：方向 + 角半径余弦（背景遮挡）
    const pl = [];
    for (const c of cel) if ((c.group === 7 || c.group === 8) && c.radius) {
      tmp.set(c.pos[0] - cam.x, c.pos[1] - cam.y, c.pos[2] - cam.z);
      const d = tmp.length(), s = Math.min(1, c.radius / d);
      pl.push([tmp.divideScalar(d).clone(), Math.sqrt(1 - s * s), s]);
    }
    pl.sort((a, b) => b[2] - a[2]);
    const U = occMat.uniforms;
    U.uNp.value = Math.min(MAX_PL, pl.length);
    for (let i = 0; i < U.uNp.value; i++) U.uPl.value[i].set(pl[i][0].x, pl[i][0].y, pl[i][0].z, pl[i][1]);
    U.uRot.value.setFromMatrix4(occCam.matrixWorld);
    U.uTan.value = tan; U.uRatio.value = cur.occ.big / cur.occ.small; U.uMask.value = cur.occ.tex;
    const rt = renderer.getRenderTarget(), ac = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(occRT);
    renderer.render(scene, occCam);
    U.uPrev.value = res[ri].texture;
    ri = 1 - ri;
    renderer.setRenderTarget(res[ri]);
    renderer.render(qs, qc);
    renderer.setRenderTarget(rt);
    renderer.autoClear = ac;
    shared.uOcc.value = res[ri].texture;
  }
  // 叠加到当前渲染目标（场景已画好、深度还在）
  function draw() {
    if (!visible || !cur) return;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(fscene, camera);
    renderer.autoClear = ac;
  }
  return {
    set, update, draw,
    dispose() { occRT.dispose(); occRT.depthTexture.dispose(); for (const r of res) r.dispose(); occMat.dispose(); for (const t of texCache.values()) t.dispose(); wipe(); },
  };
}
