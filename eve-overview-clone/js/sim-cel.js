// ===== 驾驶模拟的天体（恒星、行星、卫星）=====
// 天体数据来自 pilot-systems.json（SDE 真实星系，celOf 转成以交战点为原点的米坐标），记录里是 rec.cel。
// 距离动辄几个 AU，远超镜头远裁剪面（3 万 km），所以照常见的「缩放空间」画法：离镜头超过 NEAR 的天体，
//   沿视线拉近到 NEAR 处、半径按同一比例缩小——屏幕上的位置和角大小都不变，只是深度换了。
// 恒星：客户端是 sun_*.red 模型 + 镜头光晕（lensflare .black，见 sim-flare.js）；没有光晕数据的恒星类型用朝向镜头的加色辉光代替，
//   颜色取该恒星 graphicID 的 emissiveColor（客户端 sun.py），照船的方向光改成真实的恒星方向。
// 行星、卫星：客户端按 shaderPreset 加载模板 .red + 高度图（几百 MB 贴图，还没转换），
//   这里先用程序化着色：按行星类型配色的分形噪声地表 / 气态条带、晨昏线、向阳边缘的大气辉光（配色是近似的，不是客户端数据）。
// 空间站、星门：近处画游戏模型（sim-station.js）；小行星带：没有模型，只有总览图标（sim-3d 画）。
import * as THREE from './vendor/three/three.module.min.js';
import { createStations } from './sim-station.js?v=9';

const KM = 1 / 1000;
const NEAR = 15000;   // 千米：再远就按比例拉近
// 恒星发光色（graphicIDs.emissiveColor，按恒星 typeID）；没有的按黄色 sun_yellow_01a
const SUN_COL = { 45037: [5, 3.765, 2.608], 3799: [5, 4.451, 4.902], 3800: [6, 3.694, 2.047] };
const SUN_DEF = [5, 4.470588, 3.235294];
// 有镜头光晕数据的恒星类型（和 sim-flare.js 的 FLARE_OF_SUN 一致）
const FLARED = new Set([45037, 3799, 3800]);
// 恒星 graphicID 的 albedoColor（只有粉色系恒星有；3799 = sun_pink_sun_small_01a）
const SUN_ALB = { 3799: [2, 1.8118, 1.9608] };
// 远处照船的光（客户端 sun.py 的 sunDiffuseColor = sunColorFar）：有 albedoColor 就直接用它（实机抓帧 (1.942, 1.855, 2.014) 即此），
//   没有就取发光色的同色相、饱和度减半、明度 1.5。近处按距离往发光色插值的那部分（几个 AU 外不到 1%）不做
export function sunLight(type) {
  if (SUN_ALB[type]) return SUN_ALB[type].slice();
  const e = SUN_COL[type] || SUN_DEF, mx = Math.max(...e), mn = Math.min(...e), s = (mx - mn) / mx * 0.5;
  return e.map((x) => 1.5 * (1 - s * (mx - x) / (mx - mn || 1)));
}
// 行星类型 → 着色方案：0 岩石（温和 / 海洋 / 贫瘠 / 冰 / 熔岩 / 等离子 / 碎裂 / 卫星），1 气态条带（气体 / 风暴）
// a、b、c：低地、高地、极地 / 云的颜色；atm：大气颜色；glow：熔岩、等离子的裂缝自发光；sea：海平面（0 = 没有水）
const KIND = {
  11: { gas: 0, a: [0.05, 0.16, 0.36], b: [0.2, 0.32, 0.14], c: [0.55, 0.47, 0.36], atm: [0.35, 0.6, 1.0], sea: 0.5, cloud: 0.55 },     // 温和
  2014: { gas: 0, a: [0.02, 0.09, 0.3], b: [0.05, 0.22, 0.42], c: [0.3, 0.5, 0.55], atm: [0.3, 0.55, 1.0], sea: 0.72, cloud: 0.5 },     // 海洋
  2016: { gas: 0, a: [0.23, 0.2, 0.17], b: [0.42, 0.36, 0.29], c: [0.6, 0.55, 0.48], atm: [0.0, 0.0, 0.0], sea: 0, cloud: 0 },          // 贫瘠
  12: { gas: 0, a: [0.55, 0.66, 0.78], b: [0.78, 0.86, 0.93], c: [0.95, 0.97, 1.0], atm: [0.55, 0.75, 1.0], sea: 0, cloud: 0.2 },        // 冰体
  2015: { gas: 0, a: [0.07, 0.04, 0.03], b: [0.16, 0.1, 0.07], c: [0.26, 0.2, 0.16], atm: [0.6, 0.25, 0.08], sea: 0, cloud: 0, glow: [1.6, 0.45, 0.08] },   // 熔岩
  2063: { gas: 0, a: [0.12, 0.05, 0.16], b: [0.3, 0.14, 0.32], c: [0.5, 0.36, 0.5], atm: [0.7, 0.3, 0.9], sea: 0, cloud: 0, glow: [0.9, 0.35, 1.4] },     // 等离子
  30889: { gas: 0, a: [0.18, 0.13, 0.1], b: [0.32, 0.24, 0.18], c: [0.5, 0.42, 0.34], atm: [0, 0, 0], sea: 0, cloud: 0, glow: [1.2, 0.5, 0.15] },      // 碎裂
  13: { gas: 1, a: [0.52, 0.38, 0.24], b: [0.78, 0.66, 0.48], c: [0.4, 0.26, 0.17], atm: [0.8, 0.65, 0.45] },                               // 气体
  2017: { gas: 1, a: [0.2, 0.3, 0.42], b: [0.42, 0.52, 0.6], c: [0.14, 0.2, 0.3], atm: [0.4, 0.6, 0.9] },                                   // 风暴
  moon: { gas: 0, a: [0.24, 0.23, 0.22], b: [0.38, 0.37, 0.35], c: [0.5, 0.49, 0.47], atm: [0, 0, 0], sea: 0, cloud: 0 },
};

const VS = `varying vec3 vN, vW, vP;
  void main() { vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w; }`;
const FS = `uniform vec3 sunDir, ca, cb, cc, atm, glow; uniform float gas, sea, cloud, seed;
  varying vec3 vN, vW, vP;
  float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float n(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h(i), h(i + vec3(1, 0, 0)), f.x), mix(h(i + vec3(0, 1, 0)), h(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h(i + vec3(0, 0, 1)), h(i + vec3(1, 0, 1)), f.x), mix(h(i + vec3(0, 1, 1)), h(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * n(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
  vec3 enc(vec3 c) { return mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.0031308)))); }
  void main() {
    vec3 p = normalize(vP) + vec3(seed);
    vec3 col; float e = 0.0;
    if (gas > 0.5) {
      float y = normalize(vP).y, w = fbm(p * 3.0) * 0.35;
      float b = sin((y + w) * 22.0 + seed * 4.0) * 0.5 + 0.5, b2 = sin((y + w * 0.6) * 57.0) * 0.5 + 0.5;
      col = mix(mix(ca, cb, b), cc, b2 * 0.35);
    } else {
      float t = fbm(p * 2.2), d = fbm(p * 9.0);
      float hgt = t + (d - 0.5) * 0.18;
      col = mix(ca, cb, smoothstep(0.35, 0.65, hgt));
      col = mix(col, cc, smoothstep(0.6, 0.78, hgt));
      if (sea > 0.0) col = mix(col, ca * 0.8, step(hgt, sea * 0.62 + 0.12));
      float pole = smoothstep(0.82, 0.92, abs(normalize(vP).y) + (d - 0.5) * 0.1);
      if (sea > 0.0) col = mix(col, vec3(0.9, 0.93, 0.96), pole);
      if (cloud > 0.0) col = mix(col, vec3(0.95), smoothstep(0.55, 0.78, fbm(p * 3.3 + 7.0)) * cloud);
      e = smoothstep(0.47, 0.5, d) * smoothstep(0.53, 0.5, d) * smoothstep(0.55, 0.3, t);   // 熔岩、等离子的裂缝
    }
    vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
    float l = dot(N, sunDir), lit = smoothstep(-0.08, 0.25, l) * max(l, 0.0) * 0.85 + smoothstep(-0.1, 0.1, l) * 0.15 + 0.035;
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * smoothstep(-0.3, 0.4, l);
    vec3 c = col * lit * 1.4 + atm * rim * 0.9 + glow * e;
    gl_FragColor = vec4(enc(max(c, 0.0)), 1.0);
  }`;

function glowTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.06, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.16, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// scene：three 场景；opt：空间站 / 星门模型用的 { load(外观键), env() }（见 sim-station.js）
// 返回 { set(cel), update(camera, ORG) → 恒星方向（单位向量，场景坐标）或 null, pos(i) 天体在场景里的（缩放后）位置 }
export function createCelestials(scene, opt = {}) {
  const stations = createStations(scene, opt);
  const geo = new THREE.SphereGeometry(1, 96, 48);
  const group = new THREE.Group();
  scene.add(group);
  let list = [], sunI = -1, sunSpr = null, tex = null;
  const sunDir = new THREE.Vector3(), cam = [0, 0, 0], at = [];
  function clear() {
    for (const o of list) if (o.mesh) { group.remove(o.mesh); o.mesh.material.dispose(); }
    if (sunSpr) { group.remove(sunSpr); sunSpr.material.dispose(); sunSpr = null; }
    list = []; sunI = -1; at.length = 0;
  }
  function set(cel) {
    clear();
    stations.set(cel);
    (cel || []).forEach((c, i) => {
      const o = { c, mesh: null };
      if (c.group === 6) {
        sunI = i;
        // 有客户端镜头光晕的恒星（sim-flare.js：光晕里自带太阳核心辉光）不再叠这个占位辉光
        if (FLARED.has(c.type)) { list.push(o); return; }
        tex ||= glowTex();
        const e = SUN_COL[c.type] || SUN_DEF, m = Math.max(...e);
        sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(e[0] / m, e[1] / m, e[2] / m), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false, transparent: true }));
        sunSpr.renderOrder = -5;
        group.add(sunSpr);
      } else if (c.group === 7 || c.group === 8) {
        const k = c.group === 8 ? KIND.moon : KIND[c.type] || KIND[2016];
        const v3 = (a) => new THREE.Vector3(...(a || [0, 0, 0]));
        const mat = new THREE.ShaderMaterial({
          uniforms: { sunDir: { value: sunDir }, ca: { value: v3(k.a) }, cb: { value: v3(k.b) }, cc: { value: v3(k.c) }, atm: { value: v3(k.atm) }, glow: { value: v3(k.glow) },
            gas: { value: k.gas }, sea: { value: k.sea || 0 }, cloud: { value: k.cloud || 0 }, seed: { value: (i * 7.31) % 13 } },
          vertexShader: VS, fragmentShader: FS,
        });
        o.mesh = new THREE.Mesh(geo, mat);
        o.mesh.frustumCulled = false;
        o.mesh.visible = false;
        group.add(o.mesh);
      }
      list.push(o);
    });
  }
  const v = new THREE.Vector3();
  // camera：镜头；ORG：浮动原点（米）。每帧摆好天体，返回恒星方向
  function update(camera, ORG) {
    cam[0] = camera.position.x / KM + ORG[0]; cam[1] = camera.position.y / KM + ORG[1]; cam[2] = camera.position.z / KM + ORG[2];
    for (let i = 0; i < list.length; i++) {
      const { c, mesh } = list[i];
      const rx = c.pos[0] - cam[0], ry = c.pos[1] - cam[1], rz = c.pos[2] - cam[2];
      const d = Math.hypot(rx, ry, rz) * KM || 1;
      const s = d > NEAR ? NEAR / d : 1;
      const p = at[i] || (at[i] = new THREE.Vector3());
      p.set(camera.position.x + rx * KM * s, camera.position.y + ry * KM * s, camera.position.z + rz * KM * s);
      if (mesh) {
        const r = c.radius * KM * s;
        // 屏幕上不到半个像素就不画（只剩图标）
        mesh.visible = r / Math.max(1e-9, d * s) > 2e-4;
        mesh.position.copy(p);
        mesh.scale.setScalar(r);
      }
      if (i === sunI) {
        sunDir.set(rx, ry, rz).normalize();
        if (!sunSpr) continue;
        sunSpr.position.copy(p);
        sunSpr.scale.setScalar(0.45);
      }
    }
    stations.update(camera, ORG);
    return sunI >= 0 ? sunDir : null;
  }
  return { set, update, pos: (i) => at[i] || null, count: () => list.length, sunType: () => (sunI >= 0 ? list[sunI].c.type : null) };
}
