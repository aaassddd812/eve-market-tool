// 驾驶模拟 · 恒星系图（探针扫描器嵌在里面，客户端默认 mapProbePanelEmbedded = True）
// 照客户端 mapViewSolarSystem / mapViewProbeHandlerStandalone / probeControl_MapView 重写（只读界面代码，没有搬代码）：
//   · 恒星、行星轨道、天体标记、自己的位置
//   · 探针：青色范围球（BASE_PROBE_COLOR 0.451, 0.941, 1）+ 光标（probeCursor.black：6 根扁平箭头 cursorzshape
//     + 中心 6 块板拼成的方块 cursorxyzshape）。拖箭头沿那根轴移动，拖方块的面在那个面所在的平面里移动。
//     平时只显示阵型中心那个光标（整个阵型一起动）；按住 Shift 换成每个探针各一个（只动那一个）——客户端 SetEditMode
//   · 结果：1 个探针命中 = 红色球、2 个 = 红色虚线圆、3 个 = 两个点 + 虚线、4 个以上 = 一个点；
//     点用 scanResultLocation 图标，按信号强度上色（≤25% 红、≤75% 橙、<100% 黄、100% 绿）
// 客户端的球、箭头是专门的模型和着色器（scanbubbledoteffect / probeCursor），这里用简单几何体 + 菲涅尔近似
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const PROBE_COL = new THREE.Color(0.451, 0.941, 1);
const RES_COL = { sel: new THREE.Color(1, 0, 0), off: new THREE.Color(0.5, 0, 0) };
const RES_CSS = (s) => (s >= 1 ? 'rgb(0,204,0)' : s > 0.75 ? 'rgb(255,255,26)' : s > 0.25 ? 'rgb(230,128,0)' : 'rgb(255,0,0)');
// probeCursor.black 的 12 个子件：[名字里的轴, 旋转四元数 xyzw, 平移, 模型]（箭头 ±20、板 ±6.2，单位是光标自身的）
const CURSOR_PARTS = [
  ['x', [0, 0.7071, 0, 0.7071], [20, 0, 0], 'arrow'], ['x', [0, -0.7071, 0, 0.7071], [-20, 0, 0], 'arrow'],
  ['y', [0, 0.7071, 0.7071, 0], [0, 20, 0], 'arrow'], ['y', [0, 0.7071, -0.7071, 0], [0, -20, 0], 'arrow'],
  ['z', [0, 0, 0, 1], [0, 0, 20], 'arrow'], ['z', [0, 1, 0, 0], [0, 0, -20], 'arrow'],
  ['xy', [0, 0.7071, -0.7071, 0], [0, 0, 6.2], 'plate'], ['xy', [0, 0.7071, -0.7071, 0], [0, 0, -6.2], 'plate'],
  ['xz', [0, 0, 0, 1], [0, 6.2, 0], 'plate'], ['xz', [0, 0, 0, 1], [0, -6.2, 0], 'plate'],
  ['yz', [0, 0, 0.7071, 0.7071], [6.2, 0, 0], 'plate'], ['yz', [0, 0, 0.7071, 0.7071], [-6.2, 0, 0], 'plate'],
];
const UNIT = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

// 探针范围球：边缘亮（菲涅尔）+ 经纬网格，正面背面都画、叠加混合
const sphereVS = `varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){ vec4 w = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-w.xyz); vP = position; gl_Position = projectionMatrix*w; }`;
const sphereFS = `uniform vec3 col; uniform float a; uniform float grid; uniform float pulse; varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float dd = dot(normalize(vN), normalize(vV)), f = 1.0 - abs(dd);
  float fres = gl_FrontFacing ? pow(f, 2.7) * 0.9 + 0.03 : pow(f, 4.0) * 0.25 + 0.01;
  float lat = asin(clamp(vP.y, -1.0, 1.0)) * 6.0 / 3.14159, lon = atan(vP.z, vP.x) * 12.0 / 3.14159;
  vec2 g = abs(fract(vec2(lat, lon)) - 0.5);
  float line = grid * (1.0 - smoothstep(0.0, 0.06, min(g.x, g.y))) * 0.18;
  float sweep = pulse > 0.0 ? smoothstep(0.08, 0.0, abs(vP.y - (1.0 - 2.0 * pulse))) * 0.5 : 0.0;
  gl_FragColor = vec4(col * (fres + line + sweep) * a, 1.0);
}`;
function sphereMat(col, a = 1, grid = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { col: { value: col.clone() }, a: { value: a }, grid: { value: grid }, pulse: { value: 0 } },
    vertexShader: sphereVS, fragmentShader: sphereFS, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
}
// 光点（恒星、探针中心）
function glowTex(r, g, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(255,255,255,1)`); gr.addColorStop(0.2, `rgba(${r},${g},${b},0.9)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// 箭头：cursorzshape 是扁平的块状箭头（指向 +Z、厚度在 Y），轮廓按模型顶点取，再乘上 .black 里的缩放 (3, 2, 5)
const arrowGeo = (() => {
  const s = new THREE.Shape([[-2.16, -7.75], [2.16, -7.75], [2.16, -0.9], [4.08, -0.9], [0.72, 10.1], [-0.72, 10.1], [-4.08, -0.9], [-2.16, -0.9]].map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(s, { depth: 1.5, bevelEnabled: false }).translate(0, 0, -0.75).rotateX(Math.PI / 2);   // 轮廓的 y → +Z（箭头方向），挤出方向 → Y（厚度）
})();
// 板：cursorxyzshape 是单位立方体，缩放 (12.5, 0.1, 12.5)
const plateGeo = new THREE.BoxGeometry(12.5, 0.1, 12.5);
// SingleFresnelReflection 的近似：正对镜头暗、侧面亮一点，颜色参数 = 光标颜色
const cursorMat = () => new THREE.ShaderMaterial({
  uniforms: { col: { value: PROBE_COL.clone() } },
  vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 col; varying vec3 vN; void main(){ float f = 1.0 - abs(vN.z); gl_FragColor = vec4(col * (0.55 + 0.45 * f), 1.0); }',
});
// 光标的轴尺寸 ≈ 30（箭头尖到中心），缩放后箭头尖离中心约 1.2×sz（sz = 镜头距离 × 0.06，大小是估的）
const CURSOR_R = 25;
function cursorSet() {
  const g = new THREE.Group(), mats = {};
  for (const [ax, q, t, kind] of CURSOR_PARTS) {
    const m = (mats[ax] ||= cursorMat());
    const a = new THREE.Mesh(kind === 'arrow' ? arrowGeo : plateGeo, m);
    a.quaternion.set(...q);
    a.position.set(...t);
    // 箭头的方向 / 板的法线（只用来判断是否正对镜头）
    const dir = (kind === 'arrow' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)).applyQuaternion(a.quaternion);
    a.userData = { ax, kind, dir, m };
    g.add(a);
  }
  return g;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// box：放地图的容器；H：{ S, AU, UI, esc, tr, fmtDist, celIcon(c), icon(u), probes(), res(), step R(m), busy() 0–1 或 -1, moveProbe(k, delta[m]), selRes(id), menuRes(id, e) }
export function createSysMap(box, H) {
  const AU = H.AU, toV = (p) => new THREE.Vector3(p[0] / AU, p[1] / AU, p[2] / AU);
  const cv = box.querySelector('canvas'), ov = box.querySelector('[data-sm-ov]');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x05070a, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 5000);   // 客户端星系图 fov 0.7 弧度 ≈ 40°
  const ctl = new OrbitControls(camera, cv);
  ctl.enableDamping = true; ctl.dampingFactor = 0.15; ctl.rotateSpeed = 0.6; ctl.zoomSpeed = 1.2;
  ctl.minDistance = 0.02; ctl.maxDistance = 600;
  ctl.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  // 恒星 + 轨道
  const S = H.S, cel = S.b.cel || [];
  const sun = cel.find((c) => c.group === 6);
  const sunPos = sun ? toV(sun.pos) : new THREE.Vector3();
  const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(255, 200, 120), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
  sunSpr.scale.setScalar(0.06);
  sunSpr.position.copy(sunPos);
  scene.add(sunSpr);
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x8796a8, transparent: true, opacity: 0.28 });
  let far = 1;
  const planets = [];
  cel.forEach((c, i) => {
    if (c.group !== 7) return;
    const p = toV(c.pos), rel = p.clone().sub(sunPos), r = rel.length();
    far = Math.max(far, r);
    planets.push({ c, i, p });
    // 轨道圈：过行星、以恒星为圆心，所在平面含行星方向和水平切向
    const u = rel.clone().normalize(), v = new THREE.Vector3(0, 1, 0).cross(u).normalize();
    if (v.lengthSq() < 0.5) v.set(1, 0, 0);
    const pts = [];
    for (let k = 0; k <= 160; k++) { const a = (k / 160) * Math.PI * 2; pts.push(sunPos.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r)); }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat));
  });
  // 探针（数量会变，按需建）
  const probeG = new THREE.Group(), resG = new THREE.Group();
  scene.add(probeG, resG);
  const dotTex = glowTex(115, 240, 255);
  const pObjs = [];
  // 光标单独一个场景，画在最上层（清掉深度再画），自己内部照常做深度测试
  const top = new THREE.Scene();
  const center = cursorSet();
  center.userData.k = 'all';
  top.add(center);
  function probeObj(i) {
    if (pObjs[i]) return pObjs[i];
    const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), sphereMat(PROBE_COL, 0.4));
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
    dot.scale.setScalar(0.022);
    const arr = cursorSet();
    arr.userData.k = i;
    probeG.add(sph, dot);
    top.add(arr);
    return (pObjs[i] = { sph, dot, arr });
  }
  // HTML 标记（天体、自己、结果）：每帧投影到屏幕
  const marks = new Map();
  function mark(key, html, cls) {
    let m = marks.get(key);
    if (!m) { m = document.createElement('div'); m.className = `pl-sm-mk ${cls || ''}`; m.dataset.smK = key; ov.appendChild(m); marks.set(key, m); m._h = ''; }
    if (m._h !== html) { m.innerHTML = html; m._h = html; }
    m._live = true;
    return m;
  }
  const vT = new THREE.Vector3();
  function place(m, p) {
    vT.copy(p).project(camera);
    const vis = vT.z < 1 && Math.abs(vT.x) < 1.2 && Math.abs(vT.y) < 1.2;
    m.style.display = vis ? '' : 'none';
    if (vis) m.style.transform = `translate(${((vT.x + 1) / 2) * cv.clientWidth}px, ${((1 - vT.y) / 2) * cv.clientHeight}px)`;
  }
  // 视角：默认从斜上方看整个星系，以自己为中心
  function focus(p, dist) { const d = camera.position.clone().sub(ctl.target); ctl.target.copy(p); camera.position.copy(p).add(d.setLength(dist ?? d.length())); }
  camera.position.copy(toV(S.me.pos)).add(new THREE.Vector3(0, far * 0.9, far * 1.4));
  ctl.target.copy(toV(S.me.pos));
  const view = (k) => {
    const d = Math.max(camera.position.distanceTo(ctl.target), 0.05);
    camera.position.copy(ctl.target).add(k === 'top' ? new THREE.Vector3(0, d, 0.0001) : new THREE.Vector3(0, 0, d));
  };
  // 拖光标（客户端 mapViewScannerNavigationStandalone）：鼠标射线和一个拖动平面求交，交点的位移就是探针的位移。
  //   箭头：x 轴用水平面（Y 法线），视线和它几乎平行（|射线·法线| < 0.15）时改用 Z 法线的面；y 轴用 Z、不行用 X；z 轴用 Y、不行用 X；
  //         位移只留沿那根轴的分量
  //   方块的面：xz 面在法线 Y 的平面里拖，xy 面用 Z，yz 面用 X；视线和平面几乎平行（|射线·法线| ≤ 0.2）时拖不动
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let drag = null, hover = null, shift = false;
  const setNdc = (e) => { const r = cv.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); };
  const sets = () => [center, ...pObjs.filter(Boolean).map((o) => o.arr)];
  function pickCursor(e) {
    setNdc(e);
    const list = sets().filter((g) => g.visible).flatMap((g) => g.children.filter((a) => a.visible));
    const hit = ray.intersectObjects(list, false)[0];
    return hit ? { a: hit.object, ax: hit.object.userData.ax, set: hit.object.parent } : null;
  }
  const AXIS_PLANES = { x: ['y', 'z', 'x'], y: ['z', 'x', 'y'], z: ['y', 'x', 'z'] };
  const PLANE_N = { xz: 'y', xy: 'z', yz: 'x' };
  function dragNormal(ax) {
    const d = ray.ray.direction;
    if (PLANE_N[ax]) { const n = UNIT[PLANE_N[ax]]; return Math.abs(d.dot(n)) > 0.2 ? n : null; }
    const [a, b, c] = AXIS_PLANES[ax];
    return Math.abs(d.dot(UNIT[a])) >= 0.15 ? UNIT[a] : Math.abs(d.dot(UNIT[b])) >= 0.15 ? UNIT[b] : UNIT[c];
  }
  const plane = new THREE.Plane(), hitV = new THREE.Vector3();
  const planeHit = () => ray.ray.intersectPlane(plane, hitV) && hitV.clone();
  const onDown = (e) => {
    if (e.button !== 0) return;
    shift = e.shiftKey;
    const h = pickCursor(e);
    if (!h) return;
    e.stopPropagation();
    e.preventDefault();
    const n = dragNormal(h.ax);
    if (!n) return;
    plane.setFromNormalAndCoplanarPoint(n, h.set.position);
    const p0 = planeHit();
    if (!p0) return;
    ctl.enabled = false;
    drag = { h, p0, last: new THREE.Vector3() };
    cv.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    shift = e.shiftKey;
    if (drag) {
      setNdc(e);
      const p = planeHit();
      if (!p) return;
      const tot = p.sub(drag.p0), ax = drag.h.ax;
      if (UNIT[ax]) { const t = tot.dot(UNIT[ax]); tot.copy(UNIT[ax]).multiplyScalar(t); }
      const dv = tot.clone().sub(drag.last);
      drag.last.copy(tot);
      if (dv.lengthSq()) H.moveProbe(drag.h.set.userData.k, [dv.x * AU, dv.y * AU, dv.z * AU]);
      return;
    }
    const h = pickCursor(e);
    hover = h;
    cv.style.cursor = h ? 'pointer' : '';
  };
  // Shift 换光标：按住时显示每个探针的，松开显示阵型中心的
  const onKey = (e) => { if (e.key === 'Shift') shift = e.type === 'keydown'; };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => { shift = false; });
  const onUp = () => { if (drag) { drag = null; ctl.enabled = true; H.moveDone?.(); } };
  cv.addEventListener('pointerdown', onDown, true);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  // 地图上的鼠标操作不传给外面的主场景（主镜头的旋转、缩放、右键菜单）；结果标记的右键菜单照常
  // （挂在窗口元素上：同一元素上的窗口置顶处理照样执行，只是不再往外传）
  const winEl = box.closest('[data-win]') || box;
  const stopDown = (e) => { if (box.contains(e.target) && !e.target.closest('[data-sm-res], button')) e.stopPropagation(); };
  winEl.addEventListener('pointerdown', stopDown);
  box.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  box.addEventListener('contextmenu', (e) => { if (!e.target.closest('[data-sm-res]')) { e.preventDefault(); e.stopPropagation(); } });
  // 双击场景：顶视图 ↔ 侧视图（客户端 ToggleView）
  let lastView = 'side';
  cv.addEventListener('dblclick', () => { lastView = lastView === 'top' ? 'side' : 'top'; view(lastView); });

  // 每帧：同步探针、结果、标记
  const resObjs = new Map();
  function syncResults(list) {
    const live = new Set();
    for (const r of list) {
      const sel = H.selRes() === r.sig.id, col = sel ? RES_COL.sel : RES_COL.off, opa = sel ? 0.7 : 0.5;
      const g = r.geo || { kind: 'point', p: r.est };
      const key = `${r.sig.id}:${g.kind}:${g.n || 0}`;
      live.add(key);
      let o = resObjs.get(key);
      if (!o) {
        o = new THREE.Group();
        if (g.kind === 'sphere') o.add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), sphereMat(col, 0.6, 0)));
        else if (g.kind === 'circle' || g.kind === 'pair') o.add(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: col, transparent: true, opacity: opa, dashSize: 0.05, gapSize: 0.035, depthWrite: false })));
        resG.add(o);
        resObjs.set(key, o);
      }
      const obj = o.children[0];
      if (g.kind === 'sphere') {
        obj.position.copy(toV(g.c)); obj.scale.setScalar(g.r / AU);
        obj.material.uniforms.col.value.copy(col);
      } else if (g.kind === 'circle') {
        const c = toV(g.c), n = new THREE.Vector3(...g.n).normalize(), r = g.r / AU;
        const u = new THREE.Vector3(0, 1, 0).cross(n); if (u.lengthSq() < 1e-6) u.set(1, 0, 0); u.normalize();
        const v = n.clone().cross(u), pts = [];
        for (let k = 0; k <= 128; k++) { const a = (k / 128) * Math.PI * 2; pts.push(c.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r)); }
        obj.geometry.setFromPoints(pts); obj.computeLineDistances();
        obj.material.color.copy(col); obj.material.opacity = opa;
      } else if (g.kind === 'pair') {
        obj.geometry.setFromPoints(g.pts.map(toV)); obj.computeLineDistances();
        obj.material.color.copy(col); obj.material.opacity = opa;
      }
      // 点标记：1、2 个探针时放在球心 / 圆心，3 个时两个点各一个，4 个以上放在估计位置
      const pts = g.kind === 'pair' ? g.pts : [g.kind === 'point' ? g.p : g.c];
      const dist = H.fmtDist(len(sub(r.est, S.me.pos)));
      pts.forEach((p, k) => {
        const lbl = `${H.esc(r.sig.id)}${r.s >= 0.75 ? ' ' + H.esc(H.tr(r.sig.name)) : ''} ${H.esc(dist)}`;
        const m = mark(`r:${r.sig.id}:${k}`, `<i style="--c:${RES_CSS(r.s)}"></i><span>${lbl}</span>`, `res${sel ? ' sel' : ''}`);
        m.classList.toggle('sel', sel);
        m.dataset.smRes = r.sig.id;
        place(m, toV(p));
      });
    }
    for (const [k, o] of resObjs) if (!live.has(k)) { resG.remove(o); o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose(); }); resObjs.delete(k); }
  }
  // 光标大小跟镜头距离走（屏幕上大约固定大小）；正对镜头的那根轴的箭头藏起来（客户端 UpdateArrowVisibility）
  // 高亮：鼠标停在 / 正在拖的那根轴（两头的箭头一起）或那个面（两块板一起）变亮 (2, 2, 2)（SetCursorState）
  const camDir = new THREE.Vector3(), ACTIVE = new THREE.Color(2, 2, 2);
  function cursorAt(set, pos, on) {
    set.visible = on;
    if (!on) return;
    set.position.copy(pos);
    set.scale.setScalar((camera.position.distanceTo(pos) * 0.06) / CURSOR_R);
    camera.getWorldDirection(camDir);
    const h = drag?.h || hover, hi = h?.set === set ? h.ax : null;
    for (const a of set.children) {
      const u = a.userData;
      a.visible = u.kind !== 'arrow' || Math.abs(u.dir.dot(camDir)) < 0.97;
      u.m.uniforms.col.value.copy(u.ax === hi ? ACTIVE : PROBE_COL);
    }
  }
  let raf = 0, alive = true, lastFit = 0;
  function frame() {
    raf = 0;
    if (!alive || !box.isConnected || box.closest('[data-win]')?.hidden) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w && h && (cv.width !== Math.round(w * renderer.getPixelRatio()) || cv.height !== Math.round(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    ctl.update();
    for (const m of marks.values()) m._live = false;
    // 天体、自己
    for (const pl of planets) place(mark(`c${pl.i}`, `<img src="${H.celIcon(pl.c)}" alt=""><span>${H.esc(pl.c.name)}</span>`, 'cel'), pl.p);
    if (sun) place(mark('sun', `<span>${H.esc(sun.name)}</span>`, 'cel sun'), sunPos);
    place(mark('me', `<img src="${H.icon(S.me)}" alt="">`, 'me'), toV(S.me.pos));
    // 探针
    const pr = H.probes(), R = H.R() / AU, busy = H.busy();
    const fitKey = pr.length ? R : 0;
    if (fitKey && fitKey !== lastFit) {
      const c0 = H.center() ? toV(H.center()) : toV(S.me.pos);
      let ext = R;
      for (const p of pr) ext = Math.max(ext, toV(p.pos).distanceTo(c0) + R);
      const need = ext / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
      if (camera.position.distanceTo(c0) < need || ctl.target.distanceTo(c0) > ext) focus(c0, Math.max(need, camera.position.distanceTo(ctl.target)));
    }
    lastFit = fitKey;
    pr.forEach((p, i) => {
      const o = probeObj(i), v = toV(p.pos);
      o.sph.visible = o.dot.visible = true;
      o.sph.position.copy(v); o.sph.scale.setScalar(R);
      o.sph.material.uniforms.pulse.value = busy >= 0 ? (busy * 3) % 1 : 0;
      o.dot.position.copy(v);
    });
    for (let i = pr.length; i < pObjs.length; i++) if (pObjs[i]) { pObjs[i].sph.visible = pObjs[i].dot.visible = false; pObjs[i].arr.visible = false; }
    // 平时只有阵型中心的光标；按住 Shift 换成每个探针各一个（拖动中途松开 / 按下 Shift 不换，拖完再换）
    const c = H.center(), each = drag ? drag.h.set !== center : shift;
    pr.forEach((p, i) => cursorAt(pObjs[i].arr, toV(p.pos), each));
    if (pr.length && c) cursorAt(center, toV(c), !each); else center.visible = false;
    syncResults(H.res());
    for (const [k, m] of marks) if (!m._live) { m.remove(); marks.delete(k); }
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(top, camera);
    renderer.autoClear = true;
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };
  kick();
  return {
    kick,
    focusMe: () => { focus(toV(S.me.pos)); kick(); },
    focusAt: (p) => { focus(toV(p)); kick(); },
    view: (k) => { view(k); kick(); },
    dispose() { alive = false; winEl.removeEventListener('pointerdown', stopDown); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); if (raf) cancelAnimationFrame(raf); ctl.dispose(); renderer.dispose(); ov.innerHTML = ''; },
  };
}
