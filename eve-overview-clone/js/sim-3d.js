// ===== 战场模拟的 3D 视图（three.js）=====
// 读取 sim-engine.js 的记录（每 0.5 秒一帧：位置、三层血量、目标、这一步的开火 / 遥修、无人机位置），按时间插值画出：
//   像游戏里一样，每艘船都有总览图标（按舰船类别，A 方蓝、B 方红，残骸灰色），始终显示在屏幕上；
//   舰船本身用游戏内模型（sim-ships.js），按真实大小摆放，所以拉远时很小、拉近才看得清；没有模型文件时只显示图标。
//   开火、导弹、命中、阵亡爆炸由 sim-fx.js 按武器种类画；出击的无人机 / 舰载机中队也有总览图标；
//   悬停、选中、点名集火的船，图标外套一圈细线（像游戏里一样贴着图标）；开启诱导、诱导进场的位置有一团闪光；
//   跃迁撤离的船消失（不留残骸）。坐标单位：千米。模型逐个加载，hooks.onProgress(已加载, 总数) 报告进度。
//   像联盟锦标赛（AT）直播一样：星云天空、名字下面三层血条；「导播镜头」自动环绕战场，有船被击毁时切过去拍几秒。
// 画质（opt.quality）：high 高画质；low 不画星云、按 1 倍像素渲染；auto 先按高画质画，持续低于 24 帧就降到低画质（hooks.onQuality）。
// 观察者视角：拖动旋转、滚轮 / 双指缩放、右键 / 双指拖动平移；悬停显示舰船，点击选中，双击镜头跟随（手动转动镜头会退出导播，hooks.onDirector）。
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { loadShipIndex, loadShipModel, bracketAtlas, BRACKETS, DRONE_BRACKETS } from './sim-ships.js?v=v5';
import { createFx } from './sim-fx.js?v=v6';

const COLOR = { A: new THREE.Color(0x5b9bff), B: new THREE.Color(0xff4b3e) };
const WRECK = new THREE.Color(0x8a9099);
const KM = 1 / 1000;
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // 画在画布上的文字不走自动翻译
const ICON_PX = 18;        // 总览图标大小（CSS 像素）
const RING_PX = 9.5;       // 选中圈半径（CSS 像素，刚好套住图标）
const WRECK_ICON = BRACKETS.indexOf('wreck');

export function createView(host, hooks = {}, opt = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true });
  } catch {
    return null;
  }
  let quality = opt.quality || 'auto', level = quality === 'low' ? 'low' : 'high';
  let dpr = level === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x04060b, 1);
  host.prepend(renderer.domElement);
  renderer.domElement.className = 'sim-3d-canvas';
  // 舰船名：叠在 3D 画面上的 2D 画布，写在图标右边
  const lbl = document.createElement('canvas');
  lbl.className = 'sim-3d-labels';
  renderer.domElement.after(lbl);
  const lctx = lbl.getContext('2d');
  let labels = true;
  // 选支援落点：鼠标处画落点圈（贴在舰船所在的水平面上），点一下把落点（米）交给回调
  let placing = null, mouse = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.0002, 30000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.01;
  controls.maxDistance = 5000;
  // 缩放灵敏度接近游戏：滚轮每格约 23%；双指缩放按手指距离比例，太灵敏会跳，单独调低
  controls.zoomSpeed = 5;
  renderer.domElement.addEventListener('pointerdown', (e) => { controls.zoomSpeed = e.pointerType === 'touch' ? 1.4 : 5; });

  // 光照：一个恒星方向光 + 环境反射（深蓝星云渐变，金属漆面靠它出反光）
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sun.position.set(0.6, 0.5, 0.35);
  scene.add(sun, new THREE.AmbientLight(0x8090b0, 0.25));
  let env = null;
  {
    const pm = new THREE.PMREMGenerator(renderer);
    const s = new THREE.Scene();
    const g = new THREE.SphereGeometry(10, 48, 24);
    const col = [], p = g.attributes.position, c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 10, x = p.getX(i) / 10, z = p.getZ(i) / 10;
      c.setRGB(0.02, 0.03, 0.06).lerp(new THREE.Color(0.18, 0.22, 0.32), Math.max(0, y) ** 1.5);
      const sunD = Math.max(0, x * 0.6 + y * 0.5 + z * 0.35) / Math.hypot(0.6, 0.5, 0.35);
      c.add(new THREE.Color(1.6, 1.4, 1.1).multiplyScalar(sunD ** 64 * 3));
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    s.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    env = pm.fromScene(s, 0.02).texture;
    pm.dispose();
  }

  // 远处的星空
  {
    const n = 1500, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8000 + Math.random() * 6000);
      p.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8090a8, size: 1.5, sizeAttenuation: false })));
  }
  // 星云天空（高画质）：跟着镜头走的大球，片元里按方向算分形噪声；最先画、不写深度
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), new THREE.ShaderMaterial({
    uniforms: { sun: { value: new THREE.Vector3(0.6, 0.5, 0.35).normalize() } },
    vertexShader: `varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 sun; varying vec3 vD;
      float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h(i), h(i + vec3(1, 0, 0)), f.x), mix(h(i + vec3(0, 1, 0)), h(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(h(i + vec3(0, 0, 1)), h(i + vec3(1, 0, 1)), f.x), mix(h(i + vec3(0, 1, 1)), h(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
      float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vD);
        float a = fbm(d * 2.2), b = fbm(d * 4.0 + vec3(a * 2.0));
        float band = exp(-pow(dot(d, normalize(vec3(0.25, 1.0, -0.3))) * 2.2, 2.0));
        vec3 col = vec3(0.01, 0.014, 0.026);
        col += mix(vec3(0.11, 0.05, 0.22), vec3(0.04, 0.15, 0.28), a) * smoothstep(0.42, 0.85, b) * (0.3 + 0.7 * band);
        col += vec3(0.32, 0.16, 0.07) * pow(smoothstep(0.55, 0.95, fbm(d * 3.0 + 5.0)), 2.0) * band * 0.55;
        float s = max(0.0, dot(d, sun));
        col += vec3(1.0, 0.86, 0.62) * (pow(s, 900.0) * 5.0 + pow(s, 14.0) * 0.1);
        gl_FragColor = vec4(col, 1.0); }`,
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  }));
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  sky.visible = level === 'high';
  scene.add(sky);

  // 总览图标：屏幕空间的点精灵，图集里按类别取图
  const brGeo = new THREE.BufferGeometry();
  let brCap = 0;
  const brMat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: null }, n: { value: BRACKETS.length }, size: { value: ICON_PX * dpr } },
    vertexShader: `attribute vec4 tint; attribute float icon; varying vec4 vTint; varying float vIcon; uniform float size;
      void main() { vTint = tint; vIcon = icon; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D atlas; uniform float n; varying vec4 vTint; varying float vIcon;
      void main() { vec4 t = texture2D(atlas, vec2((vIcon + gl_PointCoord.x) / n, gl_PointCoord.y)); if (t.a * vTint.a < 0.02) discard; gl_FragColor = vec4(t.rgb * vTint.rgb, t.a * vTint.a); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const brPts = new THREE.Points(brGeo, brMat);
  brPts.frustumCulled = false;
  brPts.renderOrder = 5;
  brPts.visible = false;
  scene.add(brPts);
  bracketAtlas().then((t) => { brMat.uniforms.atlas.value = t; brPts.visible = true; });

  // 舰船模型：每种外观一个 InstancedMesh
  let shipIndex = null;
  loadShipIndex().then((x) => { shipIndex = x; lastN = -1; });
  const models = new Map();   // 外观键 → { state: 'loading'|'ok'|'none', mesh, def, units: [i] }
  const keyOf = (i) => shipIndex?.types?.[rec.units[i].ship]?.m || null;
  const iconOf = (i) => Math.max(0, BRACKETS.indexOf(shipIndex?.types?.[rec.units[i].ship]?.b || 'frigate'));
  const radiusOf = (i) => (shipIndex?.models?.[keyOf(i)]?.r || rec.units[i].radius || 50) * KM;
  function syncModels() {
    if (!shipIndex || !rec) return;
    const want = new Map();
    rec.units.forEach((u, i) => { const k = keyOf(i); if (k) (want.get(k) || want.set(k, []).get(k)).push(i); });
    for (const [k, units] of want) {
      let m = models.get(k);
      if (!m) {
        m = { state: 'loading', units, mesh: null };
        models.set(k, m);
        loadShipModel(k, renderer, env).then((def) => {
          if (models.get(k) !== m) return;
          if (!def) { m.state = 'none'; progress(); return; }
          m.def = def;
          m.state = 'ok';
          build(m);
          progress();
        });
      } else if (m.units.length !== units.length) {
        m.units = units;
        if (m.state === 'ok') build(m);
      }
    }
    progress();
  }
  function progress() {
    let done = 0;
    for (const m of models.values()) if (m.state !== 'loading') done++;
    hooks.onProgress?.(done, models.size);
  }
  function build(m) {
    if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); }
    m.mesh = new THREE.InstancedMesh(m.def.geometry, m.def.materials, m.units.length);
    m.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    m.mesh.frustumCulled = false;
    scene.add(m.mesh);
  }
  // 引擎尾焰
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const bstGeo = new THREE.BufferGeometry();
  let bstCap = 0;
  const bstMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: glowTex }, scale: { value: 1 } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vColor; uniform float scale;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(size * scale / -mv.z, 0.0, 256.0); gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform sampler2D map; varying vec3 vColor;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
      #include <logdepthbuf_fragment>
      float a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vColor * a, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const bst = new THREE.Points(bstGeo, bstMat);
  bst.frustumCulled = false;
  scene.add(bst);

  // 诱导进场的闪光（世界空间大小随距离缩放，与尾焰同一套着色器）
  const flashGeo = new THREE.BufferGeometry();
  flashGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
  flashGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
  flashGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(16), 1));
  const flash = new THREE.Points(flashGeo, bstMat);
  flash.frustumCulled = false;
  scene.add(flash);
  // 开火特效；P 是给特效模块的查询接口
  const fx = createFx(scene, renderer);
  const atV = [];
  const P = {
    get rec() { return rec; },
    at: (i) => atV[i] || null,
    posAt: (i, t, out) => posAt(i, t, out),
    radiusOf: (i) => radiusOf(i),
    get heading() { return heading; },
    shield: (i) => { const F = frameAt(lastDrawT); return i * 3 < F.hp.length && F.hp[i * 3] > 0; },
  };
  // 悬停 / 选中 / 点名集火圈：屏幕空间的细圆（1 像素线宽），贴着总览图标
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 8), 3));
  ringGeo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(4 * 8), 4));
  ringGeo.setAttribute('rad', new THREE.BufferAttribute(new Float32Array(8), 1));
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { dpr: { value: dpr } },
    vertexShader: `attribute vec4 tint; attribute float rad; varying vec4 vTint; varying float vR; uniform float dpr;
      void main() { vTint = tint; vR = rad * dpr; gl_PointSize = vR * 2.0 + 4.0 * dpr; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec4 vTint; varying float vR; uniform float dpr;
      void main() { float d = length(gl_PointCoord - 0.5) * (vR * 2.0 + 4.0 * dpr); float a = 1.0 - smoothstep(0.35 * dpr, 0.9 * dpr, abs(d - vR)); if (a < 0.02) discard; gl_FragColor = vec4(vTint.rgb, vTint.a * a); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const ringPts = new THREE.Points(ringGeo, ringMat);
  ringPts.frustumCulled = false;
  ringPts.renderOrder = 6;
  scene.add(ringPts);
  let hover = -1, sel = -1;
  // 画质档位：改像素比，按像素算大小的图标 / 圈一起改
  function applyLevel(l) {
    level = l;
    dpr = l === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    brMat.uniforms.size.value = ICON_PX * dpr;
    ringMat.uniforms.dpr.value = dpr;
    sky.visible = l === 'high';
    lastSize = '';
    resize();
  }
  const perf = { t0: 0, last: 0, n: 0, slow: 0 };
  // 自动画质：每 2 秒算一次帧率，连续两次低于 24 帧就降到低画质（切到别的标签页、中间停过 3 秒以上的重新算）
  function watchPerf() {
    if (quality !== 'auto' || level === 'low') return;
    const now = performance.now();
    if (!perf.t0 || now - perf.last > 3000) { perf.t0 = now; perf.n = 0; }
    perf.last = now;
    perf.n++;
    if (now - perf.t0 < 2000) return;
    perf.slow = perf.n * 1000 / (now - perf.t0) < 24 ? perf.slow + 1 : 0;
    perf.t0 = now;
    perf.n = 0;
    if (perf.slow >= 2) { applyLevel('low'); hooks.onQuality?.('low'); }
  }
  // 导播镜头：平时绕战场中心慢慢转（离中心的距离按存活舰船散开的范围），有船被击毁就切到残骸近景拍 3.5 秒
  let director = false, dirAng = 0.6, dirLast = 0, dirSeen = -1, dirCut = null, dirCutAt = 0;
  function directorStep(t, kills) {
    const now = performance.now(), dt = dirLast ? Math.min(0.1, (now - dirLast) / 1000) : 0;
    dirLast = now;
    kills = kills || [];
    if (dirSeen < 0 || t < lastT - 0.01) { dirSeen = 0; while (dirSeen < kills.length && kills[dirSeen].at <= t) dirSeen++; dirCut = null; }
    let k = null;
    while (dirSeen < kills.length && kills[dirSeen].at <= t) k = kills[dirSeen++];
    if (k && t - k.at < 1.5 && now - dirCutAt > 4000 && drawn[k.unit]) {
      const d = drawn[k.unit], r = Math.max(0.5, radiusOf(k.unit) * 14);
      dirCut = { i: k.unit, until: now + 3500 };
      dirCutAt = now;
      dirAng += 1.3;
      controls.target.set(d.x, d.y, d.z);
      camera.position.set(d.x + Math.cos(dirAng) * r, d.y + r * 0.45, d.z + Math.sin(dirAng) * r);
      return;
    }
    dirAng += dt * 0.06;
    if (dirCut && now < dirCut.until && drawn[dirCut.i]) {
      const d = drawn[dirCut.i], r = camera.position.distanceTo(controls.target);
      controls.target.set(d.x, d.y, d.z);
      camera.position.set(d.x + Math.cos(dirAng) * r * 0.9, d.y + r * 0.42, d.z + Math.sin(dirAng) * r * 0.9);
      return;
    }
    dirCut = null;
    let x = 0, y = 0, z = 0, n = 0;
    for (const d of drawn) if (d?.alive) { x += d.x; y += d.y; z += d.z; n++; }
    if (!n) return;
    const c = vC.set(x / n, y / n, z / n);
    let span = 0;
    for (const d of drawn) if (d?.alive) span = Math.max(span, Math.hypot(d.x - c.x, d.y - c.y, d.z - c.z));
    const dist = Math.max(3, span * 2.4), e = 1 - Math.exp(-dt * 1.2);
    controls.target.lerp(c, e);
    camera.position.lerp(vB.set(c.x + Math.cos(dirAng) * dist * 0.9, c.y + dist * 0.42, c.z + Math.sin(dirAng) * dist * 0.9), e);
  }
  const onVis = () => { perf.t0 = 0; };
  document.addEventListener('visibilitychange', onVis);
  controls.addEventListener('start', () => { if (director) { director = false; hooks.onDirector?.(false); } });

  let rec = null;
  let lastT = -1, lastSize = '', lastN = -1, lastDrawT = 0;
  let follow = -1, followAt = null, flyTo = null;
  const tmp = new THREE.Object3D();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const drawn = [];      // 本帧每艘船的位置（千米，悬停 / 选中用）
  const heading = [];    // 每艘船最后的朝向（停下 / 成为残骸后保持）

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h || `${w}x${h}` === lastSize) return;
    lastSize = `${w}x${h}`;
    renderer.setSize(w, h, false);
    lbl.width = Math.round(w * dpr);
    lbl.height = Math.round(h * dpr);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    bstMat.uniforms.scale.value = h * dpr / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  // 某处 1 个屏幕像素对应多少千米
  const kmPerPx = (p) => 2 * Math.max(1e-6, camera.position.distanceTo(p)) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, host.clientHeight);

  // 帧插值：第 i 艘船在时间 t 的位置（千米）；还没入场返回 null
  function posAt(i, t, out) {
    const F = rec.frames, dt = rec.dt;
    const k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt)));
    const a = F[k], b = F[Math.min(F.length - 1, k + 1)];
    if (i * 3 >= a.pos.length) return null;
    const f = b === a || i * 3 >= b.pos.length ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
    out.set(
      (a.pos[i * 3] + (b.pos[i * 3] - a.pos[i * 3]) * f) * KM,
      (a.pos[i * 3 + 1] + (b.pos[i * 3 + 1] - a.pos[i * 3 + 1]) * f) * KM,
      (a.pos[i * 3 + 2] + (b.pos[i * 3 + 2] - a.pos[i * 3 + 2]) * f) * KM);
    return out;
  }
  const frameAt = (t) => rec.frames[Math.max(0, Math.min(rec.frames.length - 1, Math.floor(t / rec.dt)))];

  function fit() {
    if (!rec) return;
    follow = -1; flyTo = null;
    const f = rec.frames[rec.frames.length - 1];
    const box = new THREE.Box3();
    for (let i = 0; i < f.pos.length; i += 3) box.expandByPoint(vA.set(f.pos[i] * KM, f.pos[i + 1] * KM, f.pos[i + 2] * KM));
    const c = box.getCenter(new THREE.Vector3()), span = Math.max(8, box.getSize(vB).length());
    controls.target.copy(c);
    camera.position.set(c.x + span * 0.15, c.y + span * 0.55, c.z + span * 0.95);
    camera.updateProjectionMatrix();
    controls.update();
  }
  // 镜头跟随第 i 艘船：先飞过去（离船几倍半径），之后随船移动
  function setFollow(i) {
    if (i >= 0 && director) { director = false; hooks.onDirector?.(false); }
    follow = i;
    followAt = null;
    if (i < 0 || !drawn[i]) { flyTo = null; return; }
    const r = radiusOf(i);
    const dir = vA.copy(camera.position).sub(controls.target).normalize();
    flyTo = { dist: Math.max(0.06, r * 7), dir: dir.clone(), t0: performance.now() };
  }

  function draw(t, opt = {}) {
    if (!rec || !rec.frames.length) return;
    resize();
    const F = frameAt(t);
    lastDrawT = t;
    sel = opt.sel ?? -1;
    const n = rec.units.length;
    if (n !== lastN) { lastN = n; syncModels(); }
    // 舰船位置、朝向
    for (let i = 0; i < n; i++) {
      const p = posAt(i, t, vA);
      drawn[i] = null;
      const esc = rec.units[i].escaped;
      if (!p || (esc != null && t >= esc)) continue;   // 没入场 / 已跃迁离场
      const alive = F.hp[i * 3 + 2] > 0 || (i * 3 >= F.hp.length);
      const q = posAt(i, t + rec.dt, vB) || p;
      if (!heading[i]) heading[i] = new THREE.Quaternion();
      if (alive && q.distanceToSquared(p) > 1e-12) { tmp.position.copy(p); tmp.lookAt(q); heading[i].copy(tmp.quaternion); }
      drawn[i] = { x: p.x, y: p.y, z: p.z, alive };
    }
    // 镜头跟随
    if (follow >= 0 && drawn[follow]) {
      const p = vC.set(drawn[follow].x, drawn[follow].y, drawn[follow].z);
      if (followAt) { const d = vA.copy(p).sub(followAt); controls.target.add(d); camera.position.add(d); }
      followAt = (followAt || new THREE.Vector3()).copy(p);
      if (flyTo) {
        const k = Math.min(1, (performance.now() - flyTo.t0) / 900), e = 1 - (1 - k) ** 3;
        controls.target.lerp(p, e);
        camera.position.lerp(vB.copy(p).addScaledVector(flyTo.dir, flyTo.dist), e);
        if (k >= 1) flyTo = null;
      }
    }

    if (director && follow < 0) directorStep(t, opt.kills);
    // 模型实例
    const white = new THREE.Color(1, 1, 1), dark = new THREE.Color(0.22, 0.2, 0.2);
    const bp = [], bc = [], bs = [];
    for (const m of models.values()) {
      if (m.state !== 'ok' || !m.mesh) continue;
      let c = 0;
      for (const i of m.units) {
        const d = drawn[i];
        if (!d) continue;
        tmp.position.set(d.x, d.y, d.z);
        tmp.quaternion.copy(heading[i] || tmp.quaternion.identity());
        if (!d.alive) tmp.rotateY(t * 0.02 + i);   // 残骸慢慢打转
        tmp.scale.setScalar(KM);
        tmp.updateMatrix();
        m.mesh.setMatrixAt(c, tmp.matrix);
        m.mesh.setColorAt(c, d.alive ? white : dark);
        c++;
        if (d.alive) {
          const col = COLOR[rec.units[i].side];
          for (const b of m.def.boosters) {
            vA.set(-b[0], b[1], b[2]).applyMatrix4(tmp.matrix);
            bp.push(vA.x, vA.y, vA.z);
            bc.push(0.35 + col.r * 0.2, 0.55 + col.g * 0.2, 0.9);
            bs.push(b[3] * 2.6 * KM);
          }
        }
      }
      m.mesh.count = c;
      m.mesh.instanceMatrix.needsUpdate = true;
      if (m.mesh.instanceColor) m.mesh.instanceColor.needsUpdate = true;
    }
    if (bp.length / 3 > bstCap) { bstCap = Math.ceil(bp.length / 3 * 1.5) + 64; bstGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bstCap * 3), 3)); bstGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bstCap * 3), 3)); bstGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(bstCap), 1)); }
    if (bstCap) {
      bstGeo.attributes.position.array.set(bp); bstGeo.attributes.color.array.set(bc); bstGeo.attributes.size.array.set(bs);
      bstGeo.attributes.position.needsUpdate = bstGeo.attributes.color.needsUpdate = bstGeo.attributes.size.needsUpdate = true;
      bstGeo.setDrawRange(0, bp.length / 3);
    }

    // 总览图标：模型在屏幕上够大时淡出
    const ip = [], it = [], ii = [];
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d) continue;
      vA.set(d.x, d.y, d.z);
      const px = radiusOf(i) / kmPerPx(vA);
      const hasModel = models.get(keyOf(i))?.state === 'ok';
      const a = hasModel ? Math.max(0, Math.min(1, 1 - (px - 14) / 26)) : 1;
      if (a <= 0 && opt.sel !== i) continue;
      const c = d.alive ? COLOR[rec.units[i].side] : WRECK;
      const hi = opt.sel === i ? 1.35 : 1;
      ip.push(d.x, d.y, d.z);
      it.push(Math.min(1, c.r * hi), Math.min(1, c.g * hi), Math.min(1, c.b * hi), Math.max(a, opt.sel === i ? 0.5 : 0) * (d.alive ? 1 : 0.8));
      ii.push(d.alive ? iconOf(i) : WRECK_ICON);
    }
    // 无人机 / 舰载机：前后两帧按顺序对上（同一母舰、同一类别）就插值
    const F2 = rec.frames[Math.min(rec.frames.length - 1, Math.floor(t / rec.dt) + 1)];
    const fk = F2 === F ? 0 : Math.max(0, Math.min(1, (t - F.t) / (F2.t - F.t || 1)));
    for (let j = 0; j < F.dr.length; j += 5) {
      const o = F.dr[j];
      if (!drawn[o]?.alive) continue;
      const same = F2.dr[j] === o && F2.dr[j + 4] === F.dr[j + 4];
      for (let k = 1; k <= 3; k++) ip.push((F.dr[j + k] + (same ? (F2.dr[j + k] - F.dr[j + k]) * fk : 0)) * KM);
      const c = COLOR[rec.units[o].side];
      it.push(c.r, c.g, c.b, 1);
      ii.push(DRONE_BRACKETS[F.dr[j + 4]] ?? DRONE_BRACKETS[0]);
    }
    if (ip.length / 3 > brCap) { brCap = Math.ceil(ip.length / 3 * 1.5) + 64; brGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(brCap * 3), 3)); brGeo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(brCap * 4), 4)); brGeo.setAttribute('icon', new THREE.BufferAttribute(new Float32Array(brCap), 1)); }
    if (brCap) {
      brGeo.attributes.position.array.set(ip); brGeo.attributes.tint.array.set(it); brGeo.attributes.icon.array.set(ii);
      brGeo.attributes.position.needsUpdate = brGeo.attributes.tint.needsUpdate = brGeo.attributes.icon.needsUpdate = true;
      brGeo.setDrawRange(0, ip.length / 3);
    }

    // 开火、导弹、命中、阵亡爆炸（sim-fx.js）
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d) { atV[i] = null; continue; }
      atV[i] = (atV[i] || new THREE.Vector3()).set(d.x, d.y, d.z);
    }
    fx.update(t, P, opt.kills);
    // 诱导进场闪光：进场后 4 秒内先亮后暗
    {
      const fp = flashGeo.attributes.position.array, fc = flashGeo.attributes.color.array, fs = flashGeo.attributes.size.array;
      let c = 0;
      for (const e of rec.events) {
        if (!(e.kind === 'cyno' || (e.kind === 'reinforce' && e.mode === 'cyno')) || !e.pos || c >= 16) continue;
        const age = t - e.t;
        if (age < 0 || age > 4) continue;
        const k = age < 0.4 ? age / 0.4 : 1 - (age - 0.4) / 3.6;
        fp.set([e.pos[0] * KM, e.pos[1] * KM, e.pos[2] * KM], c * 3);
        fc.set([1.2 * k, 0.75 * k, 0.35 * k], c * 3);
        fs[c] = (8 + age * 6) * k;
        c++;
      }
      flashGeo.attributes.position.needsUpdate = flashGeo.attributes.color.needsUpdate = flashGeo.attributes.size.needsUpdate = true;
      flashGeo.setDrawRange(0, c);
    }

    // 圈：悬停（细白）、选中（亮白）、点名集火（A 方青、B 方橙，稍大一圈）
    {
      const rp = ringGeo.attributes.position.array, rt = ringGeo.attributes.tint.array, rr = ringGeo.attributes.rad.array;
      let c = 0;
      const ring = (i, col, a, px) => {
        const p = i != null && i >= 0 ? drawn[i] : null;
        if (!p?.alive || c >= 8) return;
        rp.set([p.x, p.y, p.z], c * 3);
        rt.set([((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, a], c * 4);
        rr[c++] = px;
      };
      if (hover !== opt.sel) ring(hover, 0xffffff, 0.55, RING_PX);
      ring(opt.sel, 0xffffff, 1, RING_PX);
      ring(F.pa, 0x7fd4ff, 0.95, F.pa === opt.sel ? RING_PX + 3 : RING_PX);
      ring(F.pb, 0xffb15a, 0.95, F.pb === opt.sel || F.pb === F.pa ? RING_PX + (F.pb === F.pa ? 6 : 3) : RING_PX);
      ringGeo.attributes.position.needsUpdate = ringGeo.attributes.tint.needsUpdate = ringGeo.attributes.rad.needsUpdate = true;
      ringGeo.setDrawRange(0, c);
    }
    if (lastT < 0) fit();
    lastT = t;
  }

  function planePoint(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let y = 0, n = 0;
    for (const d of drawn) if (d?.alive) { y += d.y; n++; }
    plane.constant = -(n ? y / n : controls.target.y);
    return ray.ray.intersectPlane(plane, new THREE.Vector3());
  }
  function drawPlacing() {
    if (!placing || !mouse) return;
    const p = planePoint(mouse[0], mouse[1]);
    if (!p) return;
    const w = lbl.width, h = lbl.height;
    const scr = (v) => { vB.copy(v).project(camera); return [(vB.x + 1) / 2 * w, (1 - vB.y) / 2 * h, vB.z]; };
    const R = Math.max(1, kmPerPx(p) * 34);   // 落点圈约 34 像素，贴着水平面
    lctx.save();
    lctx.strokeStyle = placing.color;
    lctx.fillStyle = placing.color + '26';
    lctx.lineWidth = 2 * dpr;
    lctx.shadowColor = placing.color;
    lctx.shadowBlur = 12 * dpr;
    for (const k of [1, 0.45]) {
      lctx.beginPath();
      for (let a = 0; a <= 48; a++) {
        const q = scr(vC.set(p.x + Math.cos(a / 48 * Math.PI * 2) * R * k, p.y, p.z + Math.sin(a / 48 * Math.PI * 2) * R * k));
        if (a) lctx.lineTo(q[0], q[1]); else lctx.moveTo(q[0], q[1]);
      }
      lctx.closePath();
      if (k === 1) lctx.fill();
      lctx.stroke();
    }
    const c = scr(p);
    lctx.beginPath();
    lctx.arc(c[0], c[1], 3 * dpr, 0, Math.PI * 2);
    lctx.fillStyle = placing.color;
    lctx.fill();
    // 说明：离本方 / 敌方舰队中心多远
    const mid = (side) => { let x = 0, y = 0, z = 0, n = 0; drawn.forEach((d, i) => { if (d?.alive && rec.units[i].side === side) { x += d.x; y += d.y; z += d.z; n++; } }); return n ? vA.set(x / n, y / n, z / n).distanceTo(p) : null; };
    const own = mid(placing.side), foe = mid(placing.side === 'A' ? 'B' : 'A');
    const text = [tr(placing.label), [own != null ? tr(`距本方 ${own.toFixed(1)} km`) : '', foe != null ? tr(`距敌方 ${foe.toFixed(1)} km`) : ''].filter(Boolean).join(' · ')];
    lctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    lctx.shadowBlur = 4 * dpr;
    lctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    lctx.textBaseline = 'top';
    lctx.fillStyle = '#fff';
    const tx = Math.min(c[0] + 18 * dpr, w - lctx.measureText(text[0]).width - 8 * dpr);
    lctx.fillText(text[0], tx, c[1] + 14 * dpr);
    lctx.font = `${11 * dpr}px system-ui, sans-serif`;
    lctx.fillStyle = '#cfd6e2';
    lctx.fillText(text[1], tx, c[1] + 30 * dpr);
    lctx.restore();
  }
  function drawLabels() {
    lctx.clearRect(0, 0, lbl.width, lbl.height);
    drawPlacing();
    if (!labels || !rec) return;
    const w = lbl.width, h = lbl.height;
    lctx.font = `${11 * dpr}px system-ui, sans-serif`;
    lctx.textBaseline = 'middle';
    lctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    lctx.shadowBlur = 3 * dpr;
    // 挤在一起时与已写的名字重叠就不写（选中 / 悬停的船先写）
    const F = frameAt(lastDrawT), bw = 40 * dpr, bh = Math.max(1, 2 * dpr), lh = 13 * dpr + bh * 3 + 3 * dpr;
    const HP_COL = ['#5aa9ff', '#f0b44a', '#e85d5d'];
    const boxes = [];
    const order = drawn.map((p, i) => i).sort((a, b) => (b === sel || b === hover) - (a === sel || a === hover));
    for (const i of order) {
      const p = drawn[i];
      if (!p?.alive) continue;
      vA.set(p.x, p.y, p.z).project(camera);
      if (vA.z > 1 || Math.abs(vA.x) > 1.1 || Math.abs(vA.y) > 1.1) continue;
      const name = hooks.nameOf?.(i);
      if (!name) continue;
      const x = (vA.x + 1) / 2 * w + 14 * dpr, y = (1 - vA.y) / 2 * h - 4 * dpr, tw = Math.max(bw, lctx.measureText(name).width);
      if (boxes.some((r) => x < r[2] && x + tw > r[0] && Math.abs(y - r[1]) < lh)) continue;
      boxes.push([x, y, x + tw]);
      lctx.fillStyle = rec.units[i].side === 'A' ? '#9cc2ff' : '#ff9d94';
      lctx.fillText(name, x, y);
      // 名字下面：护盾 / 装甲 / 结构
      if (i * 3 < F.hp.length) {
        lctx.shadowBlur = 0;
        for (let k = 0; k < 3; k++) {
          const by = y + 7 * dpr + k * (bh + 1 * dpr);
          lctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
          lctx.fillRect(x, by, bw, bh);
          lctx.fillStyle = HP_COL[k];
          lctx.fillRect(x, by, bw * F.hp[i * 3 + k] / 200, bh);
        }
        lctx.shadowBlur = 3 * dpr;
      }
    }
  }

  // 悬停 / 点击：按屏幕距离找最近的船
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = 22 * 22;
    drawn.forEach((p, i) => {
      if (!p) return;
      vA.set(p.x, p.y, p.z).project(camera);
      if (vA.z > 1) return;
      const sx = (vA.x + 1) / 2 * r.width, sy = (1 - vA.y) / 2 * r.height;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return { i: best, x, y };
  }
  let down = null;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  el.addEventListener('pointerup', (e) => {
    if (placing && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) {
      const p = planePoint(e.clientX, e.clientY);
      if (p) { const cb = placing.done; placing = null; el.style.cursor = ''; cb([p.x / KM, p.y / KM, p.z / KM]); }
      down = null;
      return;
    }
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) hooks.onPick?.(pick(e).i);
    down = null;
  });
  el.addEventListener('dblclick', (e) => { const i = pick(e).i; if (i >= 0) { setFollow(i); hooks.onFollow?.(i); } });
  el.addEventListener('pointermove', (e) => { mouse = [e.clientX, e.clientY]; });
  el.addEventListener('pointerdown', (e) => { mouse = [e.clientX, e.clientY]; });
  el.addEventListener('pointerleave', () => { mouse = null; });
  el.addEventListener('pointermove', (e) => { if (placing) return; if (e.pointerType === 'mouse' && !e.buttons) { const p = pick(e); hover = p.i; hooks.onHover?.(p.i, p.x, p.y); } });
  el.addEventListener('pointerleave', () => { hover = -1; hooks.onHover?.(-1); });

  return {
    setRecord(r) {
      rec = r;
      dirSeen = -1;
      lastT = -1;
      lastN = -1;
      follow = -1;
      heading.length = 0;
      for (const m of models.values()) if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); }
      models.clear();
    },
    draw,
    render() { watchPerf(); sky.position.copy(camera.position); controls.update(); renderer.render(scene, camera); drawLabels(); },
    setLabels(on) { labels = on; drawLabels(); },
    setDirector(on) { director = on; dirSeen = -1; dirLast = 0; dirCut = null; if (on) { follow = -1; flyTo = null; } },
    setQuality(q) { quality = q; perf.slow = 0; perf.t0 = 0; applyLevel(q === 'low' ? 'low' : 'high'); },
    // 选落点：opt = { side, color: '#rrggbb', label, done(pos) }；null 取消
    setPlacing(opt) { placing = opt; el.style.cursor = opt ? 'crosshair' : ''; if (opt) { hover = -1; hooks.onHover?.(-1); } },
    resetCamera: fit,
    follow: setFollow,
    following: () => follow,
    dispose() { ro.disconnect(); document.removeEventListener('visibilitychange', onVis); fx.dispose(); for (const m of models.values()) m.mesh?.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove(); lbl.remove(); }
  };
}
