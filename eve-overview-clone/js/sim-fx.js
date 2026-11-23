// ===== 战场模拟：开火、导弹、命中、爆炸特效（three.js）=====
// 按 sim-engine 记录的开火（[开火方, 目标, 0 未命中 | 1 命中 | 2 遥修, 第几门武器]）和每门武器的特效信息（rec.units[i].fx）画：
//   激光：脉冲是短促闪光、集束是持续光束，颜色按晶体；混合：疾速炮一串等离子弹、磁轨炮一道细长光迹；
//   射弹：自动加农炮连串曳光弹、火炮大炮口闪光 + 重型曳光弹；三神裔分解器持续光束、沃顿投射器电弧；
//   导弹：先朝外飞再拐向目标，带尾焰和拖尾，爆炸大小 = 导弹爆炸半径，颜色按主伤害类型；
//   命中：护盾还在时护盾泡上亮起一片波纹，打穿护盾后是船体上的火光与火花；未命中的从目标旁边擦过去；
//   阵亡：白闪、火球、冲击波环。尺寸按真实米数，拉远时有最小像素宽度，远看也能看到交火。
// 电子战 / 遥修（rec.units[i].ew，装备开着才画）：网子紫色波纹、扰频橙色 / 扰断蓝色光环一圈圈推向目标、
//   中和琥珀色电弧 / 吸电紫色倒流（新周期时一闪）、ECM 彩色闪电、阻尼绿色雾流、标记红色细光、
//   遥修护盾蓝 / 装甲橙 / 结构灰的光点流向被修的船；目标身上同色光晕。图案按屏幕像素排布，拉远拉近疏密不变。
// opt.tex（驾驶模拟）：改用游戏客户端的特效贴图（tools/ui-assets/fetch.mjs --fx 转换到 assets/eveui/fx/，版权归 CCP）：
//   柔光 / 星芒 / 光环用游戏的粒子贴图，火球和爆炸按游戏的 9 × 9 帧爆炸序列逐帧播放，光束横截面用游戏的光束贴图。
//   贴图加载完之前（或加载失败）用程序画的图集。ready() 告诉调用方贴图是否已就绪（加载失败也算就绪）。
import * as THREE from './vendor/three/three.module.min.js';
import { createClientFx } from './sim-cfx.js?v=v10';

const KM = 1 / 1000;
const SIZE_M = [0, 1, 2, 4, 10];                 // 武器尺寸（小 / 中 / 大 / 超大）→ 宽度倍数
const REP = new THREE.Color(0x3ee08f);
const SHIELD = new THREE.Color(0x7fc4ff);
const FIRE = new THREE.Color(0xffa04a);
const MISSILE = new THREE.Color(0xffe2a8);
const TRAIL = new THREE.Color(0.95, 0.78, 0.55);
const PUFF = new THREE.Color(0.2822, 0.2443, 0.2224);
// 电子战 / 遥修：类别 → [图案序号, 颜色, 宽度（米）, 最小像素宽]
// 电子战 / 遥修：[图案, 颜色, 起点宽（米）, 最小像素, 终点宽 = 目标半径 × 倍数（0 = 和起点一样）]
// 颜色取客户端 fisfx/module/*.black 的 DiffuseColor：
//   网子 stasisweb 0.61/0.68/1.0（锥形漩涡罩向目标）；扰频 warpscrambler 0.31/0.59/0.87（闪电束）；扰断 warpdisruptor 0.32/0.88/0.71（交叉线 + 目标光环）；
//   中和 energydestabilization 1.0/0.52/0.46；吸电 energyvampire 0.88/0.90/1.0 闪电 + 1.0/0.47/0.25；ECM ecm_tr 0.68/0.83/1.0（只在目标身上的漩涡）；
//   阻尼 sensordampener 0.67/0.80/1.0（锥形波纹）；标记 targetpaint 1.0/0.26/0.19（锥形）；遥修护盾 shieldtransfer 0.47/0.83/1.0、装甲 remotearmorrepair 1.0/0.44/0
export const EW = {
  web: [0, 0x9badff, 20, 4, 2.6], scram: [1, 0x5096de, 26, 3], point: [2, 0x52dfb5, 22, 3], neut: [3, 0xff8574, 40, 4, 1.6], nos: [4, 0xe1e6ff, 26, 3],
  ecm: [5, 0xadd4ff, 0, 0], damp: [6, 0xaacbff, 18, 4, 2.4], paint: [7, 0xff4330, 8, 2, 1.8], rs: [8, 0x77d4ff, 45, 4], ra: [8, 0xff7000, 45, 4], rh: [8, 0xc8ccd6, 45, 4],
  // 下面几类只在客户端特效素材没加载好时用这套旧画法（颜色是我取的近似，不是客户端值）
  td: [6, 0xffb36b, 18, 4, 2.4], gd: [6, 0xffd36b, 18, 4, 2.4], rc: [8, 0xfff0a0, 30, 3], rb: [8, 0x9fd8ff, 30, 3], rt: [8, 0xb0ffd0, 30, 3],
};
const EW_COL = Object.fromEntries(Object.entries(EW).map(([k, v]) => [k, new THREE.Color(v[1])]));
const hash = (a, b = 0, c = 0) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// 公共的对数深度片段（渲染器开了 logarithmicDepthBuffer）
const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOG_F = '#include <common>\n#include <logdepthbuf_pars_fragment>\n';

function atlas() {
  const T = 128, c = document.createElement('canvas');
  c.width = T * 4; c.height = T;
  const x = c.getContext('2d');
  const radial = (ox, stops) => { const g = x.createRadialGradient(ox + T / 2, T / 2, 0, ox + T / 2, T / 2, T / 2); stops.forEach(([o, a]) => g.addColorStop(o, `rgba(255,255,255,${a})`)); x.fillStyle = g; x.fillRect(ox, 0, T, T); };
  radial(0, [[0, 1], [0.2, 0.7], [0.5, 0.18], [1, 0]]);                         // 0 柔光
  radial(T, [[0, 1], [0.08, 0.9], [0.3, 0.15], [1, 0]]);                        // 1 闪光（加十字光芒）
  x.save(); x.translate(T * 1.5, T / 2);
  for (let k = 0; k < 4; k++) { x.rotate(Math.PI / 4 * (k ? 2 : 1)); const g = x.createLinearGradient(-T / 2, 0, T / 2, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(-T / 2, -1.5, T, 3); }
  x.restore();
  for (let k = 0; k < 26; k++) {                                                   // 2 火球（一团团噪点）
    const a = hash(k, 1) * Math.PI * 2, r = hash(k, 2) * T * 0.28, s = T * (0.1 + hash(k, 3) * 0.2);
    const g = x.createRadialGradient(T * 2.5 + Math.cos(a) * r, T / 2 + Math.sin(a) * r, 0, T * 2.5 + Math.cos(a) * r, T / 2 + Math.sin(a) * r, s);
    g.addColorStop(0, `rgba(255,255,255,${0.35 + hash(k, 4) * 0.4})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(T * 2, 0, T, T);
  }
  const g = x.createRadialGradient(T * 3.5, T / 2, T * 0.36, T * 3.5, T / 2, T / 2);   // 3 冲击波环
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.6, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(T * 3, 0, T, T);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 一批可增长的四边形（每个 4 顶点 6 索引），属性按名字 → 分量数
function quadBatch(attrs, material) {
  const geo = new THREE.BufferGeometry();
  let cap = 0, n = 0;
  const data = {};
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  function grow(need) {
    cap = Math.max(need, Math.ceil(cap * 1.5) + 64);
    for (const [k, size] of Object.entries(attrs)) {
      const old = data[k];
      data[k] = new Float32Array(cap * 4 * size);
      if (old) data[k].set(old.subarray(0, Math.min(old.length, data[k].length)));
      geo.setAttribute(k, new THREE.BufferAttribute(data[k], size));
    }
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return {
    mesh,
    begin() { n = 0; },
    // vals：每个属性一个数组（长度 = 分量数），四个顶点共用；corner 单独给
    push(vals) {
      if (n >= cap) grow(n + 1);
      for (let v = 0; v < 4; v++) {
        for (const [k, size] of Object.entries(attrs)) {
          const arr = data[k], o = (n * 4 + v) * size;
          const src = k === 'corner' ? [v & 1, v >> 1 ? 1 : -1] : vals[k];
          for (let j = 0; j < size; j++) arr[o + j] = src[j];
        }
      }
      n++;
    },
    end() {
      for (const k of Object.keys(attrs)) if (geo.attributes[k]) geo.attributes[k].needsUpdate = true;
      geo.setDrawRange(0, n * 6);
      mesh.visible = n > 0;
    },
  };
}

export function createFx(scene, renderer, opt = {}) {
  const res = new THREE.Vector2(1, 1);
  const tex = atlas();
  // 游戏特效贴图（灰度：亮度 = 强度）
  const ccp = { value: 0 }, cSpr = { value: null }, cExp = { value: null }, cBeam = { value: null };
  const ccp2 = { value: 0 }, cTur = { value: null }, cShd = { value: null }, cRamp = { value: null }, cFire = { value: null };
  const time = { value: 0 };
  let ccpReady = !opt.tex;
  if (opt.tex) {
    const base = opt.tex.replace(/\/?$/, '/');
    const ld = new THREE.TextureLoader();
    const one = (f) => new Promise((ok, no) => ld.load(base + f, ok, undefined, no));
    Promise.all(['sprites.webp', 'explosion.webp', 'beam.webp'].map(one)).then(([a, b, c]) => {
      for (const t of [a, b, c]) { t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
      cSpr.value = a; cExp.value = b; cBeam.value = c; ccp.value = 1;
    }).catch(() => { /* 用程序画的图集 */ }).finally(() => { ccpReady = true; });
    // 第二批：游戏炮塔弹道噪声（射弹 / 激光 / 混合三格，RGB 各一层）、护盾受击格纹、死亡爆炸色带、火团。缺了就退回第一批的画法
    Promise.all(['turret.webp', 'shield.webp', 'ramp.png', 'fire.webp'].map(one)).then(([a, b, c, d]) => {
      for (const t of [a, b, c, d]) { t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
      a.wrapS = a.wrapT = THREE.ClampToEdgeWrapping;
      b.wrapS = b.wrapT = THREE.RepeatWrapping; b.generateMipmaps = true; b.minFilter = THREE.LinearMipmapLinearFilter;
      c.wrapS = c.wrapT = d.wrapS = d.wrapT = THREE.ClampToEdgeWrapping;
      cTur.value = a; cShd.value = b; cRamp.value = c; cFire.value = d; ccp2.value = 1;
    }).catch(() => {});
  }
  // 火球贴图格：游戏贴图时按进度取爆炸序列的帧（2 + 帧号 / 100），尺寸放大（序列帧在格子里偏小）
  const fireTile = (prog) => (ccp.value ? 2 + Math.min(80, Math.max(0, Math.floor(prog * 81))) / 100 : 2);
  const fireScale = () => (ccp.value ? 1.7 : 1);
  // 光束 / 曳光：屏幕空间的带子，宽度按米换算成像素、不小于 minpx；style 1 为拖尾（尾部渐隐）
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms: { res: { value: res }, ccp, cBeam, ccp2, cTur, time },
    vertexShader: `${LOG_V}
      attribute vec3 pa; attribute vec3 pb; attribute vec2 corner; attribute vec4 col; attribute vec4 wst; uniform vec2 res;
      varying vec3 vQ; varying vec4 vCol; varying float vStyle; varying float vTex; varying float vLen;
      void main() {
        mat4 pv = projectionMatrix * viewMatrix;
        vec4 ca = pv * vec4(pa, 1.0), cb = pv * vec4(pb, 1.0);
        // 自己在近平面稍前处裁掉镜头后面那一段（不交给 GPU 裁，否则端点投到几亿像素外，带子插值会坏成一条粗白条）
        float e = max(1e-5, projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0) * 1.05);
        if (ca.w < e && cb.w < e) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        if (ca.w < e) ca = mix(ca, cb, (e - ca.w) / (cb.w - ca.w));
        if (cb.w < e) cb = mix(cb, ca, (e - cb.w) / (ca.w - cb.w));
        vec2 sa = ca.xy / ca.w * res, sb = cb.xy / cb.w * res;
        vec2 d = sb - sa; vLen = length(d) * 0.5; d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
        vec2 nr = vec2(-d.y, d.x);
        vec4 c = corner.x < 0.5 ? ca : cb;
        float px = wst.x * projectionMatrix[1][1] * res.y * 0.5 / c.w;
        float w = min(max(px, wst.y), max(wst.y, 24.0)); vTex = wst.w;   // 贴近镜头时不超过 24 像素宽
        c.xy += nr * corner.y * w / res * c.w;
        gl_Position = c;
        // 带子坐标按屏幕线性插值（乘 w、片元里再除）：一端被裁到镜头跟前时，透视插值会把整条带子都算成中线 → 一条粗白条
        vQ = vec3(corner * c.w, c.w); vCol = col; vCol.a *= clamp(px / max(wst.y, 1e-3) * 0.4 + 0.65, 0.65, 1.0); vStyle = wst.z;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      uniform float ccp; uniform sampler2D cBeam; uniform float ccp2; uniform sampler2D cTur; uniform float time;
      varying vec3 vQ; varying vec4 vCol; varying float vStyle; varying float vTex; varying float vLen;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 vUv = vQ.xy / vQ.z;
        float a = 1.0 - abs(vUv.y);
        float core = pow(a, 5.0), glow = pow(a, 1.6) * 0.55;
        if (ccp > 0.5) { float p = texture2D(cBeam, vec2(vUv.y * 0.5 + 0.5, 0.5)).r; glow = p * p * 0.8 + pow(a, 2.0) * 0.3; core *= 0.9 + 0.3 * p; }
        // 游戏炮塔弹道的噪声贴图：两层沿弹道反向滚动（一快一慢），R / G / B 各当一层，调制光晕和亮芯
        if (ccp2 > 0.5 && vTex > 0.5) {
          float tile = floor(vTex + 0.5) - 1.0, sx = vUv.x * vLen / 220.0, vy = vUv.y * 0.4 + 0.5;
          vec3 n1 = texture2D(cTur, vec2((tile + clamp(fract(sx - time * 1.9), 0.01, 0.99)) / 6.0, vy)).rgb;
          vec3 n2 = texture2D(cTur, vec2((tile + clamp(fract(sx * 0.37 + time * 0.8), 0.01, 0.99)) / 6.0, 1.0 - vy)).rgb;
          glow *= 0.6 + 0.6 * n1.g * (0.5 + 0.6 * n2.r) + 0.2 * n2.b;
          core *= 0.8 + 0.35 * n1.r;
        }
        if (vStyle > 1.5) { core = 0.0; glow = pow(a, 2.2) * 0.55; }   // 光晕层：只有柔光，替代游戏画面的泛光
        float k = (core + glow) * vCol.a;
        if (vStyle > 0.5 && vStyle < 1.5 || vStyle > 2.5) k *= vUv.x * vUv.x;
        gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), core * 0.65) * k, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ribbons = quadBatch({ pa: 3, pb: 3, corner: 2, col: 4, wst: 4 }, ribbonMat);
  // 电子战光束：和光束同样的屏幕空间带子，片元里按类别画图案（vD 为沿光束的屏幕像素 / 20）
  const ewMat = new THREE.ShaderMaterial({
    uniforms: { res: { value: res }, time },
    vertexShader: `${LOG_V}
      attribute vec3 pa; attribute vec3 pb; attribute vec2 corner; attribute vec4 col; attribute vec4 wst; attribute float wb; uniform vec2 res;
      varying vec3 vQ; varying vec4 vCol; varying float vKind; varying float vLen; varying float vSeed;
      void main() {
        mat4 pv = projectionMatrix * viewMatrix;
        vec4 ca = pv * vec4(pa, 1.0), cb = pv * vec4(pb, 1.0);
        // 自己在近平面稍前处裁掉镜头后面那一段（不交给 GPU 裁，否则端点投到几亿像素外，带子插值会坏成一条粗白条）
        float e = max(1e-5, projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0) * 1.05);
        if (ca.w < e && cb.w < e) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        if (ca.w < e) ca = mix(ca, cb, (e - ca.w) / (cb.w - ca.w));
        if (cb.w < e) cb = mix(cb, ca, (e - cb.w) / (ca.w - cb.w));
        vec2 sa = ca.xy / ca.w * res, sb = cb.xy / cb.w * res;
        vec2 d = sb - sa; vLen = length(d) * 0.5 / 20.0; d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
        vec2 nr = vec2(-d.y, d.x);
        vec4 c = corner.x < 0.5 ? ca : cb;
        float wm = corner.x < 0.5 ? wst.x : (wb > 0.0 ? wb : wst.x);   // 锥形：终点宽另给
        float px = wm * projectionMatrix[1][1] * res.y * 0.5 / c.w;
        float w = wb > 0.0 ? clamp(px, wst.y, 90.0) : clamp(px, wst.y, wst.y * 2.5);   // 光束拉近时不无限变粗；锥形照实际大小
        c.xy += nr * corner.y * w / res * c.w;
        gl_Position = c;
        vQ = vec3(corner * c.w, c.w); vCol = col; vKind = wst.z; vSeed = wst.w;   // 同上，屏幕线性插值
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      uniform float time; varying vec3 vQ; varying vec4 vCol; varying float vKind; varying float vLen; varying float vSeed;
      vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 vUv = vQ.xy / vQ.z;
        float u = vUv.x, v = vUv.y, d = u * vLen, T = time + vSeed * 10.0;
        int k = int(vKind + 0.5);
        vec3 col = vCol.rgb;
        float a = 1.0 - abs(v), core = pow(a, 5.0), glow = pow(a, 1.6) * 0.5, m = 1.0;
        if (k == 0 || k == 6 || k == 7) {   // 锥形罩：边缘亮（菲涅耳）、中间透；网子 = 焦散漩涡往回卷，阻尼 = 波纹格往目标推，标记 = 细红锥
          float edge = pow(abs(v), 3.0) * 0.8 + 0.18;
          core = 0.0;
          if (k == 0) { float sw = sin(v * 4.0 + u * 7.0 + T * 1.6) * sin(-v * 2.5 + u * 4.0 - T * 1.1); m = (0.35 + 0.9 * sw * sw) * edge; glow = 0.45; }
          else if (k == 6) { m = (0.3 + 0.9 * pow(0.5 + 0.5 * sin(u * 18.0 - T * 5.0), 4.0)) * (0.75 + 0.25 * sin(v * 6.0)) * edge; glow = 0.45; }
          else { m = (0.5 + 0.5 * pow(0.5 + 0.5 * sin(d * 2.5 - T * 3.0), 2.0)) * edge * 1.6; glow = 0.6; core = pow(a, 8.0) * 0.6; }
          m *= smoothstep(0.0, 0.25, u);   // 起点收尖
        } else if (k == 1) {                // 扰频：两道抖动的蓝色闪电缠在一起，忽明忽暗
          float j1 = sin(d * 6.1 + T * 27.0 + vSeed * 9.0) * 0.3 + sin(d * 15.0 - T * 19.0) * 0.15;
          float j2 = sin(d * 4.3 - T * 23.0 + vSeed * 5.0) * 0.35 + sin(d * 11.0 + T * 31.0) * 0.12;
          core = (pow(max(0.0, 1.0 - abs(v - j1) * 1.7), 14.0) + pow(max(0.0, 1.0 - abs(v - j2) * 1.7), 14.0) * 0.8) * 1.3;
          glow *= 0.7; m = 0.75 + 0.25 * sin(T * 13.0 + vSeed * 7.0);
        } else if (k == 2) {                // 扰断：细亮芯 + 一节节交叉线往目标推
          float r = fract(d * 1.4 - T * 2.6);
          m = 0.45 + 1.1 * smoothstep(0.55, 0.7, r) * (1.0 - smoothstep(0.85, 1.0, r)); core *= 1.2;
        } else if (k == 3 || k == 4) {      // 中和（锥形 + 电弧）/ 吸电（电弧，亮斑从目标流回来）
          float j = sin(d * 7.3 + T * 31.0 + vSeed * 9.0) * 0.32 + sin(d * 17.0 - T * 23.0) * 0.18;
          core = pow(max(0.0, 1.0 - abs(v - j) * 1.6), 14.0) * 1.4; glow *= 0.6;
          if (k == 3) { glow += pow(abs(v), 3.0) * 0.35; }
          else { m = 0.4 + 0.9 * pow(0.5 + 0.5 * sin(d * 3.0 + T * 8.0), 4.0); col = mix(col, vec3(1.0, 0.47, 0.25), 0.5 * m * (1.0 - abs(v))); }
        } else {                            // 遥修：光点流向被修的船
          float r = fract(d * 1.2 - T * 2.2);
          m = 0.3 + 1.4 * exp(-pow((r - 0.5) * 5.0, 2.0)); glow *= 1.1;
        }
        m *= smoothstep(0.0, 0.04, u) * (0.6 + 0.4 * smoothstep(1.0, 0.9, u));
        float x = (core + glow) * m * vCol.a;
        gl_FragColor = vec4(mix(col, vec3(1.0), core * 0.5) * x, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ewBeams = quadBatch({ pa: 3, pb: 3, corner: 2, col: 4, wst: 4, wb: 1 }, ewMat);
  ewBeams.mesh.renderOrder = 2;
  scene.add(ewBeams.mesh);
  ribbons.mesh.renderOrder = 3;
  scene.add(ribbons.mesh);

  // 精灵（闪光、火球、冲击波、导弹头）：始终面向镜头，尺寸按米、不小于 minpx
  const spriteMat = new THREE.ShaderMaterial({
    uniforms: { res: { value: res }, map: { value: tex }, ccp, cSpr, cExp, ccp2, cRamp, cFire },
    vertexShader: `${LOG_V}
      attribute vec3 center; attribute vec2 corner; attribute vec4 col; attribute vec4 sz; uniform vec2 res;
      varying vec2 vUv; varying vec4 vCol; varying float vTile;
      void main() {
        vec4 mv = viewMatrix * vec4(center, 1.0);
        float minW = sz.y * 2.0 * (-mv.z) / (projectionMatrix[1][1] * res.y);
        float s = max(sz.x, minW) * 0.5;
        vec2 q = vec2(corner.x * 2.0 - 1.0, corner.y);
        float cr = cos(sz.w), sr = sin(sz.w);
        mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * s;
        gl_Position = projectionMatrix * mv;
        vUv = vec2(corner.x, corner.y * 0.5 + 0.5); vCol = col; vTile = sz.z;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      uniform sampler2D map; uniform sampler2D cSpr; uniform sampler2D cExp; uniform float ccp; uniform float ccp2; uniform sampler2D cRamp; uniform sampler2D cFire;
      varying vec2 vUv; varying vec4 vCol; varying float vTile;
      // 死亡爆炸色带：横向 = 冷却（左白热 → 右暗红），纵向 = 时间（上 = 刚炸）
      vec3 ramp(float heat, float prog) { return texture2D(cRamp, vec2(clamp(1.0 - heat, 0.02, 0.98), clamp(1.0 - prog, 0.02, 0.98))).rgb; }
      void main() {
        #include <logdepthbuf_fragment>
        float a;
        vec3 col = vCol.rgb;
        if (ccp > 0.5 && vTile > 1.95 && vTile < 2.95) {          // 爆炸序列的一帧（9 × 9）
          float f = floor((vTile - 2.0) * 100.0 + 0.5);
          vec2 cell = vec2(mod(f, 9.0), floor(f / 9.0));
          a = texture2D(cExp, vec2((cell.x + vUv.x) / 9.0, 1.0 - (cell.y + 1.0 - vUv.y) / 9.0)).r * 1.5;
          if (ccp2 > 0.5) col = mix(col, ramp(min(1.0, a * 0.8), f / 80.0) * 1.7, 0.75);
        } else if (ccp2 > 0.5 && vTile > 4.95 && vTile < 5.995) {  // 火团（fireshape），按进度用色带上色
          float prog = (vTile - 5.0) * 100.0 / 99.0;
          float v = texture2D(cFire, vUv).r;
          a = smoothstep(prog * 0.8, prog * 0.8 + 0.35, v) * 1.3;
          col = ramp(v * (1.0 - prog * 0.7), prog) * 1.8;
        } else if (ccp > 0.5) {                                     // 柔光 / 星芒 / 喷口 / 光环
          float s = vTile > 3.5 ? 2.0 : vTile > 2.5 ? 3.0 : floor(vTile + 0.01);
          a = texture2D(cSpr, vec2((s + vUv.x) / 4.0, vUv.y)).r;
        } else {
          a = texture2D(map, vec2((min(3.0, floor(vTile + 0.01)) + vUv.x) / 4.0, vUv.y)).a;
        }
        a *= vCol.a;
        gl_FragColor = vec4(mix(col, vec3(1.0), a * a * 0.35) * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sprites = quadBatch({ center: 3, corner: 2, col: 4, sz: 4 }, spriteMat);
  sprites.mesh.renderOrder = 4;
  scene.add(sprites.mesh);

  // 护盾命中：护盾泡（球）上朝开火方的一片波纹
  const MAXS = 256;
  const shieldGeo = new THREE.IcosahedronGeometry(1, 4);
  const iDir = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 3), 3);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 4), 4);
  shieldGeo.setAttribute('iDir', iDir);
  shieldGeo.setAttribute('iCol', iCol);
  const shieldMat = new THREE.ShaderMaterial({
    uniforms: { ccp2, cShd },
    vertexShader: `${LOG_V}
      attribute vec3 iDir; attribute vec4 iCol; varying vec3 vN; varying vec3 vDir; varying vec4 vCol; varying vec3 vView;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(position); vDir = iDir; vCol = iCol; vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      uniform float ccp2; uniform sampler2D cShd;
      varying vec3 vN; varying vec3 vDir; varying vec4 vCol; varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        float d = dot(vN, vDir);
        float age = vCol.a;                                   // 0 → 1
        float spot = smoothstep(0.93 - age * 0.06, 1.0, d);
        float wave = exp(-pow((d - (0.985 - age * 0.12)) * 40.0, 2.0)) * 0.7 * step(0.8, d);
        float hex = 0.85 + 0.15 * sin(vN.x * 90.0) * sin(vN.y * 90.0) * sin(vN.z * 90.0);
        // 游戏护盾的格纹：按球面经纬度铺（绕一圈 4 次），格线亮、格子里暗
        if (ccp2 > 0.5) hex = 0.2 + 1.5 * texture2D(cShd, vec2(atan(vN.z, vN.x) * 0.6366, vN.y * 1.3 + 0.5)).r;
        float a = (spot * 0.8 + wave) * hex;   // 随时间的衰减已乘进颜色（客户端 TemporalFadeoutMap）
        a *= (0.35 + 0.35 * abs(dot(vN, vView))) * 0.6;
        gl_FragColor = vec4(vCol.rgb * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const shields = new THREE.InstancedMesh(shieldGeo, shieldMat, MAXS);
  shields.frustumCulled = false;
  shields.renderOrder = 3;
  scene.add(shields);

  const tmp = new THREE.Object3D();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), vE = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let nShield = 0, curP = null;

  // 绘制工具
  // tx：弹道噪声贴图 0 不用 / 1 自动炮 / 2 光束激光 / 3 疾速炮 / 4 脉冲激光 / 5 磁轨炮 / 6 火炮
  const ribbon = (a, b, widthM, minPx, color, alpha, streak = 0, tx = 0) => ribbons.push({ pa: [a.x, a.y, a.z], pb: [b.x, b.y, b.z], col: [color.r, color.g, color.b, alpha], wst: [widthM * KM, minPx, streak, tx] });
  // 光晕：同一段弹道外面再套一层 4 倍宽的柔光（streak 为真时同样尾部渐隐）
  const halo = (a, b, widthM, minPx, color, alpha, streak = 0) => ribbon(a, b, widthM * 4, minPx * 4, color, alpha * 0.45, streak ? 3 : 2);
  const sprite = (p, sizeM, minPx, color, alpha, tile = 0, rot = 0) => sprites.push({ center: [p.x, p.y, p.z], col: [color.r, color.g, color.b, alpha], sz: [sizeM * KM, minPx, tile, rot] });
  // 护盾泡：有船体护盾椭球时（客户端护盾受击特效贴在 SOF 的 shapeEllipsoid 上）按椭球、随船转；否则用 1.25 倍包围球。
  // u = P.shield(目标)（目标序号 + 1，0 = 护盾没了）。返回受击方向上护盾表面的点（放闪光用）
  // 客户端 fisfx/impact/temporalfadeout_01a.dds 的 R 通道（512 点取 33 点），按冲击已过的寿命比例查：
  // 一开始全亮，0.2 处降到约 0.4，平台后渐隐到 0（客户端按 1 − 剩余寿命比例查同一张图）
  const FADE = [1, 1, 0.988, 0.871, 0.725, 0.561, 0.424, 0.345, 0.357, 0.427, 0.4, 0.412, 0.4, 0.373, 0.416, 0.392, 0.369, 0.353, 0.325, 0.298, 0.271, 0.239, 0.208, 0.176, 0.145, 0.11, 0.0784, 0.0588, 0.0353, 0.0235, 0, 0, 0];
  const fadeAt = (t) => { const x = Math.min(1, Math.max(0, t)) * (FADE.length - 1), i = Math.min(FADE.length - 2, Math.floor(x)); return FADE[i] + (FADE[i + 1] - FADE[i]) * (x - i); };
  const shellM = new THREE.Matrix4(), shellI = new THREE.Matrix3(), hitP = new THREE.Vector3(), lDir = new THREE.Vector3();
  function shieldHit(center, rKm, dir, age, color = SHIELD, u = 0) {
    let m = null;
    if (u > 0 && curP?.shell?.(u - 1, shellM)) {
      m = shellM;
      lDir.copy(dir).applyMatrix3(shellI.setFromMatrix4(m).invert()).normalize();   // 世界方向 → 单位球上的方向
    } else {
      tmp.position.copy(center); tmp.quaternion.identity(); tmp.scale.setScalar(rKm * 1.25); tmp.updateMatrix();
      m = tmp.matrix;
      lDir.copy(dir);
    }
    hitP.copy(lDir).applyMatrix4(m);
    if (nShield >= MAXS) return hitP;
    shields.setMatrixAt(nShield, m);
    iDir.setXYZ(nShield, lDir.x, lDir.y, lDir.z);
    const f = fadeAt(age);
    iCol.setXYZW(nShield, color.r * f, color.g * f, color.b * f, Math.min(1, age));
    nShield++;
    return hitP;
  }

  // 命中效果：护盾波纹 + 表面闪光，或船体火光 + 火花
  function impact(S, at, toPos, rKm, fromPos, size, age, color, shieldUp, seed) {
    if (age < 0 || age > 0.8) return;
    const dir = vD.copy(fromPos).sub(toPos).normalize();
    const f = 1 - age / 0.8;
    if (shieldUp) {
      sprite(vE.copy(shieldHit(toPos, rKm, dir, age / 0.8, SHIELD, shieldUp)), 20 * size, 2.5, SHIELD, f * 0.9, 1, seed * 6);
    } else {
      const p = vE.copy(toPos).addScaledVector(dir, rKm * 0.55);
      sprite(p, 30 * size * (0.6 + age) * fireScale(), 2.5, FIRE, f, fireTile(age / 0.8), seed * 6);
      sprite(p, 14 * size, 2, color, f * f, 1, seed * 5);
      for (let k = 0; k < 3; k++) {               // 火花
        const a = hash(seed * 7 + k, 1) * Math.PI * 2, b = hash(seed * 7 + k, 2) - 0.5;
        vC.set(Math.cos(a), b, Math.sin(a)).normalize().add(dir).normalize();
        sprite(vB.copy(p).addScaledVector(vC, age * 0.25 * size * KM * 300), 4 * size, 1.2, FIRE, f * f, 0);
      }
    }
  }

  // 开火点：船体上的一个挂点（按武器序号固定），随船转向
  function hardpoint(out, i, k, P) {
    const r = P.radiusOf(i) * 0.45;
    out.set((hash(i, k, 1) - 0.5) * r, (hash(i, k, 2) - 0.3) * r * 0.5, (hash(i, k, 3) - 0.2) * r);
    if (P.heading[i]) out.applyQuaternion(P.heading[i]);
    return out.add(P.at(i));
  }
  // 落点：命中打在目标身上，未命中从旁边擦过、飞得更远
  function aimPoint(out, from, to, i, j, seed, hit, rKm) {
    out.copy(to);
    if (hit) return out.add(vC.set(hash(seed, 1) - 0.5, hash(seed, 2) - 0.5, hash(seed, 3) - 0.5).multiplyScalar(rKm * 0.6));
    const d = vC.copy(to).sub(from);
    const side = vD.set(hash(seed, 4) - 0.5, hash(seed, 5) - 0.5, hash(seed, 6) - 0.5).cross(d).normalize();
    return out.addScaledVector(side, rKm * (1.6 + hash(seed, 7) * 2)).addScaledVector(d, 0.25);
  }

  // 客户端装备特效（sim-cfx.js，只在给了 opt.tex 时用；某一类素材没加载好之前用下面的旧画法）
  const cfx = opt.tex ? createClientFx(scene, opt.tex.replace(/\/?$/, '/') + 'cfx/') : null;
  const CFX = new Set(['web', 'scram', 'point', 'neut', 'nos', 'ecm', 'damp', 'td', 'gd', 'rc', 'rb', 'rt']);
  const CFX_FILE = { rb: 'gd' };   // 远程感应增强和制导扰断在客户端是同一个效果（ElectronicAttributeModifyTarget → SensorBooster_St）
  const qI = new THREE.Quaternion();
  function clientFx(P, i, j, m, kind, t, k) {
    if (!cfx || !CFX.has(kind) || !P.camera || !cfx.ready(CFX_FILE[kind] || kind)) return false;
    // 本周期开始了多久：有周期起点记录（fire 位）的按它；电脑控制的网子 / 扰频 / 阻尼等在模拟里是一直开着的，
    // 没有周期记录，就从这次开启算起按装备周期循环（客户端每个周期 Repeat 一次 play_start）
    let age = cycleStart(P.rec, k, i, m, t, 30);
    if (age < 0) {
      const F = P.rec.frames, bm = 1 << m;
      let b = 0;
      while (b < 3000 && F[k - b - 1]?.act?.[i] & bm) b++;
      const cyc = P.rec.units[i].ew?.find((y) => y[0] === m)?.[2] || 5;
      const f0 = F[Math.max(0, Math.min(k - b, F.length - 1))];
      age = f0 ? Math.max(0, t - (f0.t - P.rec.dt)) % cyc : 0;
    }
    return cfx.play(CFX_FILE[kind] || kind, `${i}:${m}`, age, {
      src: P.at(i), dst: P.at(j), R: P.radiusM(j),
      srcExt: P.extentOf(i)?.map((x) => x * 1.2), dstExt: P.extentOf(j)?.map((x) => x * 1.2),
      srcQ: P.heading[i] || qI, dstQ: P.heading[j] || qI,
    });
  }
  // 装备本周期开始了多久（往回找这门装备的 fire 位）
  const cycleStart = (rec, k, i, m, t, maxAge) => {
    for (let b = 0; ; b++) { const fr = rec.frames[k - b]; if (!fr || t - fr.t > maxAge) return -1; if (fr.fire?.[i] & (1 << m)) return Math.max(0, t - (fr.t - rec.dt)); }
  };

  // 电子战 / 遥修：本帧开着的装备（act 位）画到目标（电子战 = 本帧目标 tg，遥修 = rr）；中和 / 吸电 / ECM 新周期（fire 位）时一闪
  const cycleAge = (rec, k, i, m, t) => {
    for (let b = 0; b < 12; b++) { const fr = rec.frames[k - b]; if (!fr) break; if (fr.fire?.[i] & (1 << m)) return Math.max(0, t - (fr.t - rec.dt)); }
    return 9;
  };
  function ewBeam(P, i, j, m, kind, t, k) {
    const e = EW[kind], to = P.at(j);
    if (!e || !to) return;
    if (clientFx(P, i, j, m, kind, t, k)) return;
    const from = hardpoint(vA, i, 20 + m, P);
    const c = EW_COL[kind], rKm = P.radiusOf(j), sd = hash(i, m);
    let a = kind === 'web' || kind === 'damp' ? 0.32 : 0.75;
    if (kind === 'neut' || kind === 'nos' || kind === 'ecm') a = 0.3 + 0.9 * Math.exp(-cycleAge(P.rec, k, i, m, t) * 2.2);
    // ECM（ecm_tr）：没有光束，只在目标身上一团转动的淡蓝波纹（两层反向转）
    if (kind === 'ecm') {
      sprite(to, rKm * 2600, 10, c, 0.22 * a, 3, t * 0.9 + sd * 6);
      sprite(to, rKm * 2000, 8, c, 0.3 * a, 0, -t * 1.3);
      sprite(to, rKm * 1300, 6, c, 0.35 * a, 1, t * 2.1);
      return;
    }
    ewBeams.push({ pa: [from.x, from.y, from.z], pb: [to.x, to.y, to.z], col: [c.r, c.g, c.b, a], wst: [e[2] * KM, e[3], e[0], sd], wb: [e[4] ? rKm * e[4] : 0] });
    sprite(to, rKm * 1600, 8, c, 0.05 + a * 0.05, 0);
    if (kind === 'scram') {           // 目标处一团蓝光，跟着闪电一起跳（客户端点光源 100 / 250 米）
      const f = 0.6 + 0.4 * Math.abs(Math.sin(t * 11 + sd * 9) * Math.sin(t * 4.3));
      sprite(to, rKm * 1000 + 250, 8, c, 0.35 * f, 0); sprite(to, rKm * 1000 + 100, 5, c, 0.5 * f, 1, t * 3);
    }
    if (kind === 'point') {           // 扰断：目标处一圈圈光环往外扩（rings_01）
      const ph = (t * 0.9 + sd) % 1;
      sprite(to, rKm * 1000 * (2 + ph * 2.5), 8, c, 0.4 * (1 - ph), 3);
    }
    if (kind === 'paint') sprite(to, rKm * 1000 * 1.4, 6, c, 0.35 + 0.15 * Math.sin(t * 6 + sd * 5), 1, t * 0.5);   // 标记：目标上一颗红色瞄准光
  }
  // 范围装备（立体炸弹 / ECM 脉冲 / 跃迁扰断力场 / 微跳预热）：画在自己船上，不需要目标
  const AREA = /^(smart_|burst$|bubble$|mjd$)/;
  const bubbleMat = new THREE.ShaderMaterial({
    uniforms: { col: { value: new THREE.Color(0x9fc8ff) }, a: { value: 0.35 } },
    vertexShader: `${LOG_V} varying vec3 vN, vV; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
    fragmentShader: `${LOG_F} uniform vec3 col; uniform float a; varying vec3 vN, vV; void main() {
      #include <logdepthbuf_fragment>
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(col * (0.08 + pow(f, 3.0)) * a, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const bubbleGeo = new THREE.SphereGeometry(1, 48, 24);
  const bubbles = new Map();
  function areaFx(P, i, m, kind, cyc, range, t, k) {
    const at = P.at(i);
    if (!at) return;
    const age = Math.max(0, cycleStart(P.rec, k, i, m, t, Math.max(cyc, 1) + 1));
    if (kind === 'bubble') {
      // 客户端 warp_disruption_field_generator（EveEffectRoot2 + 粒子 + 专用 warpdisruptionbubble.fx）这套播放器还画不了：先画一个按 warpScrambleRange 的半透明球
      let b = bubbles.get(i);
      if (!b) { b = new THREE.Mesh(bubbleGeo, bubbleMat); b.renderOrder = 3; scene.add(b); bubbles.set(i, b); }
      b.position.copy(at); b.scale.setScalar(range * KM); b.visible = true; b.userData.seen = t;
      return;
    }
    if (age < 0) return;
    // 立体炸弹（EMPWave：装备图形 × empFieldRange / 1000）、ECM 脉冲（ShipEffect，按自身包围球半径）、微跳预热（MicroJumpDriveEngage，按包围球半径、跟船转）
    const file = kind, R = kind.startsWith('smart_') ? range / 1000 : P.radiusM(i);
    if (cfx && P.camera && cfx.ready(file)) {
      const len = cfx.length(file);
      if (len > 0 && age * len / cyc > len + 0.05) return;
      cfx.play(file, `${i}:${m}`, age, { dst: at, R, rot: kind === 'mjd' ? P.heading[i] : null }, len > 0 && cyc > 0 ? len / cyc : 1);
      return;
    }
    // 素材没到：一圈往外扩的光
    const f = Math.min(1, age / Math.max(0.5, cyc * 0.3));
    if (kind.startsWith('smart_') || kind === 'burst') sprite(at, range * 2 * f, 8, EW_COL.rb, 0.4 * (1 - f), 3);
  }
  // 微跳落点（MicroJumpDriveJump：落点处按包围球半径，不拉伸时间）
  function mjdJumps(P, t) {
    if (!cfx || !P.camera) return;
    for (const e of P.rec.events || []) {
      if (e.kind !== 'mjd' || t < e.t || t > e.t + 4 || !cfx.ready('mjdjump')) continue;
      cfx.play('mjdjump', `mjd:${e.unit}:${e.t}`, t - e.t, { dst: new THREE.Vector3(...e.to).sub(new THREE.Vector3(...(P.org?.() || [0, 0, 0]))).multiplyScalar(KM), R: P.radiusM(e.unit) });
    }
  }
  // 别人的出 / 入跃迁闪光（WarpFlash.py）：自己的船只有隧道。短于 4 万 km 的跃迁不播
  // 起跳：在闪光那一刻的位置放 warp_out，缩放 (r, r, 8)，r = 0.0039·R + 2.5（R = 包围球半径，米）；船上叠 warp_glow，缩放 (r/2, r/2, 6)，朝运动方向；1.5 秒后清掉
  // 落地：在落地闪光那一刻的位置放 warp_in_glow（同时最多 5 个，多的用 warp_in_noglow），缩放 0.7778·R^0.3534；
  //       船上叠 warp_glow，缩放 0.125·(9e-8·R² + 0.005·R + 0.6898)·(1, 1, 3)，跟船的位置和朝向；3 秒后清掉
  const wDir = new THREE.Vector3(), wAt = new THREE.Vector3(), wAt2 = new THREE.Vector3();
  function warpFlashes(P, t) {
    if (!cfx || !P.camera) return;
    const me = P.self?.() ?? -1, glowLen = cfx.length('warpglow') || 0.5;
    let glows = 0;
    for (const e of P.rec.events || []) {
      if (e.kind !== 'warp' || e.tOut == null || e.unit === me || e.D < 4e7) continue;
      const R = P.radiusM(e.unit);
      const ao = t - e.tOut;
      if (ao >= 0 && ao < 1.5 && cfx.ready('warpout') && cfx.ready('warpglow')) {
        const r = 0.0039 * R + 2.5;
        wDir.set(e.dir[0], e.dir[1], e.dir[2]);
        const p0 = P.posAt(e.unit, e.tOut, wAt);
        if (p0) cfx.play('warpout', `wo:${e.unit}:${e.t}`, ao, { dst: p0, dir: wDir, S: [r, r, 8] });
        const cur = P.at(e.unit);
        if (ao < glowLen && cur) cfx.play('warpglow', `wog:${e.unit}:${e.t}`, ao, { dst: cur, dir: wDir, S: [r / 2, r / 2, 6] });
      }
      const ai = t - e.tIn;
      if (ai >= 0 && ai < 3) {
        const kind = glows < 5 ? 'warpin' : 'warpin2';
        if (kind === 'warpin') glows++;
        if (!cfx.ready(kind)) continue;
        const sc = 0.7778 * Math.pow(R, 0.3534);
        const p1 = P.posAt(e.unit, e.tIn, wAt2);
        if (p1) cfx.play(kind, `wi:${e.unit}:${e.t}`, ai, { dst: p1, S: [sc, sc, sc] });
        const cur = P.at(e.unit);
        if (ai < glowLen && cur && cfx.ready('warpglow')) {
          const g = 0.125 * (9e-8 * R * R + 0.005 * R + 0.6898);
          cfx.play('warpglow', `wig:${e.unit}:${e.t}`, ai, { dst: cur, rot: P.heading[e.unit], S: [g, g, 3 * g] });
        }
      }
    }
  }
  // 脉冲波投射器的力场（引擎事件 kind 'field'）：服务器在出伤时刻的目标位置生成 AOE 信标，客户端在信标上播
  // modular_aoepulse_tr_t1a（生成那一刻）和 modular_aoecycle_tr_t1a（力场持续期间循环）。两个文件根节点自带 3500 的缩放（波前最后约 17 km），
  // 按 ShipEffect 还要乘信标球半径——信标半径没有依据，这里取 1（按文件里的绝对尺寸）
  // 特效素材没到时退回画一个半径 doomsdayAOERange 的半透明球（颜色按电子战种类）
  const FIELD_COL = { web: 'web', paint: 'paint', damp: 'damp', track: 'td', guide: 'gd', bubble: 'point', neut: 'neut', ecm: 'ecm' };
  const fieldMeshes = new Map();
  function fieldFx(P, t) {
    for (const b of fieldMeshes.values()) b.visible = false;
    const real = cfx && P.camera && cfx.ready('aoepulse') && cfx.ready('aoecycle');
    for (const e of P.rec.events || []) {
      if (e.kind !== 'field' || !e.pos) continue;
      const one = e.end - e.at < 0.5, end = one ? e.at + 2 : e.end;
      if (t < e.at || t > end + 4) continue;
      const o = P.org?.() || [0, 0, 0], dst = new THREE.Vector3((e.pos[0] - o[0]) * KM, (e.pos[1] - o[1]) * KM, (e.pos[2] - o[2]) * KM);
      if (real) {
        const lp = cfx.length('aoepulse'), lc = cfx.length('aoecycle') || 2;
        if (t - e.at < lp + 0.05) cfx.play('aoepulse', `fp:${e.unit}:${e.at}`, t - e.at, { dst, R: 1 });
        if (!one && t < e.end) cfx.play('aoecycle', `fc:${e.unit}:${e.at}`, (t - e.at) % lc, { dst, R: 1 });
        continue;
      }
      if (t > end + 1) continue;
      let b = fieldMeshes.get(e);
      if (!b) {
        const mat = bubbleMat.clone();
        mat.uniforms.col.value = (EW_COL[FIELD_COL[e.k]] || new THREE.Color(0x9fc8ff)).clone();
        b = new THREE.Mesh(bubbleGeo, mat); b.renderOrder = 3; scene.add(b); fieldMeshes.set(e, b);
      }
      const a = Math.min(1, (t - e.at) / (one ? 0.3 : 1), Math.max(0, end + (one ? 0 : 1) - t) / (one ? 1.7 : 1));
      b.material.uniforms.a.value = 0.45 * Math.max(0, a);
      b.position.copy(dst);
      b.scale.setScalar(e.r * KM);
      b.visible = true;
    }
  }
  function ewar(P, t, k) {
    const rec = P.rec, fr = rec.frames[Math.min(k, rec.frames.length - 1)];
    for (const b of bubbles.values()) b.visible = false;
    fieldFx(P, t);
    warpFlashes(P, t);
    if (!fr?.act) return;
    for (let i = 0; i < rec.units.length; i++) {
      const ew = rec.units[i].ew, act = fr.act[i];
      if (!act || !ew?.length) continue;
      for (const [m, kind, cyc, range] of ew) if (AREA.test(kind) && act & (1 << m)) areaFx(P, i, m, kind, cyc, range || 0, t, k);
    }
    mjdJumps(P, t);
    for (let i = 0; i < rec.units.length; i++) {
      const ew = rec.units[i].ew, act = fr.act[i], j = fr.tg[i];
      if (!ew?.length || !act || j == null || j < 0 || !P.at(i)) continue;
      for (const [m, kind] of ew) if (kind[0] !== 'r' && !AREA.test(kind) && act & (1 << m)) ewBeam(P, i, j, m, kind, t, k);
    }
    const rr = fr.rr || [];
    for (let x = 0; x < rr.length; x += 3) {
      const i = rr[x], m = rr[x + 2];
      if (!P.at(i)) continue;
      const kind = rec.units[i].ew?.find((y) => y[0] === m)?.[1];
      if (kind) ewBeam(P, i, rr[x + 1], m, kind, t, k);
    }
  }

  // 一发炮台射击。时间线照客户端开火特效（model/turret/*/*_fx.black 的 TriCurveSet 关键帧和 constParameters）：
  //   脉冲激光 强度 0.001 秒到 1、0.2 秒 0.25、0.55 秒熄灭，7 Hz 闪烁；光束激光 0.01 秒 0.75、0.3 秒 1、1.28 秒 0.05、1.5 秒熄灭，16 Hz 闪烁；
  //   疾速炮 三发等离子团（0.014 / 0.092 / 0.171 秒）；磁轨炮 一发弹丸，弹道留一道光 0.61 秒后 1.25 秒内淡掉；
  //   自动炮 0.5 秒的一串曳光弹（0.75 秒前淡完）；火炮 0.09 秒起大炮口闪光、0.28 秒熄，炮弹落点 1.5 倍强度的爆闪
  const crv = (K, x) => { if (x <= K[0][0]) return K[0][1]; for (let i = 1; i < K.length; i++) if (x < K[i][0]) { const [t0, v0] = K[i - 1], [t1, v1] = K[i]; return v0 + (v1 - v0) * (x - t0) / (t1 - t0); } return K[K.length - 1][1]; };
  const K_PULSE = [[0, 0], [0.001, 1], [0.2, 0.25], [0.55, 0]];
  const K_BEAM = [[0, 0], [0.01, 0.75], [0.3, 1], [1.276, 0.05], [1.5, 0]];
  const K_RAIL = [[0, 0], [0.014, 1], [0.61, 1], [0.9, 0.106], [1.25, 0]];
  const K_AUTO = [[0, 0], [0.001, 1], [0.5, 1], [0.75, 0.035], [0.85, 0]];
  const K_HIT = [[0, 1], [0.03, 1], [0.07, 0.1], [0.3, 0]];          // 疾速 / 磁轨落点光（Dest_Light_Intensity）
  const K_ARTY_MZ = [[0, 0], [0.094, 0], [0.095, 1.43], [0.117, 0.25], [0.65, 0]];
  const K_ARTY_HIT = [[0, 1.5], [0.005, 1], [0.087, 0.39], [0.32, 0.093], [0.8, 0]];
  const flick = (t, hz, amp, seed) => 1 - amp * (0.5 + 0.5 * Math.sin((t * hz + seed) * Math.PI * 2));
  function splash(Tp, rT, A, s, k, color, shieldUp, seed, age) {
    if (k <= 0.01) return;
    const dir = vD.copy(A).sub(Tp).normalize();
    if (shieldUp) sprite(vE.copy(shieldHit(Tp, rT, dir, Math.min(0.9, 1 - k), SHIELD, shieldUp)), 36 * s, 4, color, Math.min(1, k), 1, seed * 6 + age * 3);
    else { const p = vE.copy(Tp).addScaledVector(dir, rT * 0.55); sprite(p, 40 * s, 4, FIRE, Math.min(1, k) * 0.9, fireTile(Math.min(0.99, age)), seed * 6); sprite(p, 20 * s, 3, color, Math.min(1, k), 1, seed * 5); }
  }
  function turretShot(P, fx, from, to, hit, tf, t, seed, g) {
    const age = t - tf;
    // 游戏里炮塔弹道比实际米数夸张得多（再加上画面泛光）：宽度 / 闪光统一放大 2.5 倍
    const s = SIZE_M[fx.s || 1] * 2.5;
    const color = new THREE.Color(fx.c);
    // 有炮塔模型时从这门炮的炮塔打出（同槽 a / b 挂点按发次轮流），否则用船上的散列点
    const A = P.mount?.(from, P.rec.units[from].gm?.[g], seed, new THREE.Vector3()) || hardpoint(new THREE.Vector3(), from, seed % 8, P);
    const rT = P.radiusOf(to);
    const Tp = P.at(to);
    const B = aimPoint(new THREE.Vector3(), A, Tp, from, to, seed, hit, rT);
    const dist = A.distanceTo(B);
    const shieldUp = P.shield(to);
    const sd = hash(seed, 9);
    switch (fx.w) {
      case 'pulse': {
        const k = crv(K_PULSE, age) * flick(age, 7, 0.5, sd);
        if (k > 0.005) {
          ribbon(A, B, 5 * s, 2.4, color, k, 0, 4); halo(A, B, 5 * s, 2.4, color, k);
          sprite(A, 36 * s, 3.5, color, k * 0.85, 1, seed);
          if (hit) splash(Tp, rT, A, s, k * 1.2, color, shieldUp, seed, age);
        }
        break;
      }
      case 'beam': case 'disint': {
        const k = crv(K_BEAM, fx.w === 'disint' ? age * 0.8 : age) * flick(age, 16, 0.2, sd);
        if (k > 0.005) {
          ribbon(A, B, (fx.w === 'disint' ? 7 : 6) * s, 2.4, color, k, 0, 2); halo(A, B, 6 * s, 2.4, color, k);
          sprite(A, 32 * s, 3.5, color, k * 0.7, 1, age * 3);
          if (hit) splash(Tp, rT, A, s * 0.9, k, color, shieldUp, seed + Math.floor(age / 0.4), age % 0.4);
        }
        break;
      }
      case 'blaster': {
        // 三团等离子，6 km/s，落点各闪一下
        const travel = Math.min(0.47, Math.max(0.06, dist / 6));
        [0.014, 0.092, 0.171].forEach((d0, b) => {
          const ab = age - d0;
          if (ab < 0) return;
          const u = ab / travel;
          if (u <= 1) {
            const head = vC.copy(A).lerp(B, u), tail = vD.copy(A).lerp(B, Math.max(0, u - Math.min(0.3, 0.18 * s / Math.max(dist, 0.01))));
            ribbon(tail, head, 5 * s, 2.3, color, 1, 1, 3); halo(tail, head, 5 * s, 2.3, color, 1, 1);
            sprite(head, 11 * s, 3.1, color, 0.95, 0);
          }
          if (ab < 0.06) sprite(A, 20 * s, 3.5, color, 1 - ab / 0.06, 1, seed + b);
          if (hit) splash(Tp, rT, A, s * 0.7, crv(K_HIT, ab - travel) * (ab >= travel ? 1 : 0), color, shieldUp, seed + b, ab - travel);
        });
        break;
      }
      case 'rail': {
        // 一发弹丸 24 km/s；弹道留下一道光，按 K_RAIL 淡掉
        const travel = Math.min(0.5, Math.max(0.04, dist / 24));
        const u = Math.min(1, age / travel), k = crv(K_RAIL, age);
        if (k > 0.005) { ribbon(A, vC.copy(A).lerp(B, u), 2.2 * s, 2, color, k * 0.75, 0, 5); halo(A, vC.copy(A).lerp(B, u), 2.2 * s, 2, color, k * 0.6); }
        if (age < travel) { vE.copy(A).lerp(B, Math.max(0, u - Math.min(0.25, 0.5 * s / Math.max(dist, 0.01)))); ribbon(vE, vC.copy(A).lerp(B, u), 4 * s, 2.4, color, 1, 1, 5); halo(vE, vC, 4 * s, 2.4, color, 1, 1); }
        if (age < 0.15) sprite(A, 32 * s, 4.5, color, 1 - age / 0.15, 1, seed);
        if (hit && age >= travel) splash(Tp, rT, A, s, crv(K_HIT, age - travel), color, shieldUp, seed, age - travel);
        break;
      }
      case 'auto': {
        // 0.5 秒一串曳光弹（每 0.055 秒一发、19 km/s），炮口按 12 Hz 闪
        const travel = Math.min(0.35, Math.max(0.05, dist / 19));
        const k = crv(K_AUTO, age);
        if (age < 0.5) sprite(A, 16 * s, 3.5, FIRE, flick(age, 12, 0.7, sd), 1, seed + Math.floor(age * 12));
        for (let b = 0; b < 9; b++) {
          const ab = age - b * 0.055;
          if (ab < 0) break;
          const u = ab / travel;
          if (u <= 1) {
            const head = vC.copy(A).lerp(B, u), tail = vD.copy(A).lerp(B, Math.max(0, u - Math.min(0.35, 0.12 * s / Math.max(dist, 0.01))));
            ribbon(tail, head, 2.5 * s, 2.2, color, k, 1, 1); halo(tail, head, 2.5 * s, 2.2, color, k * 0.8, 1);
          }
          if (hit && b % 3 === 0) splash(Tp, rT, A, s * 0.6, crv(K_HIT, ab - travel) * (ab >= travel ? 1 : 0), color, shieldUp, seed + b, ab - travel);
        }
        break;
      }
      case 'arty': {
        // 大炮口闪光（0.095 秒起），炮弹 9 km/s、最长 0.7 秒，落点强爆闪
        const travel = Math.min(0.7, Math.max(0.12, dist / 9));
        const mz = crv(K_ARTY_MZ, age);
        if (mz > 0.01) { sprite(A, 70 * s, 4.5, FIRE, Math.min(1, mz), 1, seed); sprite(A, 90 * s * (1 + age * 2) * fireScale(), 4.5, FIRE, Math.min(1, mz) * 0.6, fireTile(Math.min(0.99, age / 0.65)), seed); }
        const ab = age - 0.095, u = ab / travel;
        if (ab >= 0 && u <= 1) { vE.copy(A).lerp(B, Math.max(0, u - Math.min(0.25, 0.3 * s / Math.max(dist, 0.01)))); ribbon(vE, vC.copy(A).lerp(B, u), 7 * s, 2.4, color, 1, 1, 6); halo(vE, vC, 7 * s, 2.4, color, 1, 1); }
        if (hit && ab >= travel) splash(Tp, rT, A, s * 1.5, crv(K_ARTY_HIT, ab - travel), color, shieldUp, seed, ab - travel);
        break;
      }
      case 'vorton': {
        if (age < 0.35) {
          const k = 1 - age / 0.35, segs = 7, phase = Math.floor(age / 0.05);
          let prev = A.clone();
          for (let j = 1; j <= segs; j++) {
            const p = A.clone().lerp(B, j / segs);
            if (j < segs) p.add(vE.set(hash(seed, j, phase) - 0.5, hash(seed, j + 9, phase) - 0.5, hash(seed, j + 19, phase) - 0.5).multiplyScalar(dist * 0.08));
            ribbon(prev, p, 3 * s, 2.2, color, k);
            prev = p;
          }
        }
        if (hit) impact(null, 0, Tp, rT, P.at(from), s, age, color, shieldUp, seed);
        break;
      }
      default:
        if (age < 0.4) ribbon(A, B, 3 * s, 2.2, color, 1 - age / 0.4);
    }
  }

  // 末日武器（structure/doomsday/doomsday_t1_fx.black，24 秒时间线压到本武器的预热 + 出伤时长）：
  //   预热：开火方船头一团越胀越大的光球（SphereScaling 0.025 → 0.42）+ 闪电亮斑（LightningFocal），亮度一路爬升；
  //   出伤：一道粗光柱（主束），落点持续爆闪；结束 0.5 秒内收掉
  const DOOM = new THREE.Color(0x9fd6ff);
  function doomsday(P, d, t) {
    if (t < d.t0 || t > d.end + 0.6) return;
    const A0 = P.at(d.f), T = P.at(d.to);
    if (!A0 || !T) return;
    const A = hardpoint(vA, d.f, 30, P).clone();
    const rF = P.radiusOf(d.f) / KM, rT = P.radiusOf(d.to);
    const warn = Math.max(0.1, d.fire - d.t0);
    if (t < d.fire) {
      const u = (t - d.t0) / warn;                                   // 0 → 1
      const sc = crv([[0, 0.025], [0.29, 0.05], [0.5, 0.11], [0.66, 0.15], [0.74, 0.2], [0.76, 0.42], [1, 0.42]], u);
      sprite(A, rF * sc * 4, 6, DOOM, 0.35 + 0.65 * u, 0);
      sprite(A, rF * sc * 2.2, 4, new THREE.Color(1, 1, 1), 0.4 + 0.6 * u, 1, t * 0.5);
      for (let j = 0; j < 4; j++) {                                  // 闪电亮斑
        if (hash(d.f, j, Math.floor(t * 9)) > 0.25 + 0.5 * (1 - u)) continue;
        vB.set(hash(d.f, j, 1) - 0.5, hash(d.f, j, 2) - 0.5, hash(d.f, j, 3) - 0.5).normalize().multiplyScalar(rF * KM * sc * 1.6);
        ribbon(A, vC.copy(A).add(vB), 3, 1, DOOM, 0.8 * u, 0);
      }
      return;
    }
    const age = t - d.fire, out = Math.max(0, Math.min(1, (d.end + 0.5 - t) / 0.5));
    const k = Math.min(1, age / 0.15) * out * flick(t, 6, 0.15, d.f);
    ribbon(A, T, 300, 8, DOOM, k, 0, 2); halo(A, T, 300, 8, DOOM, k);
    ribbon(A, T, 90, 3, new THREE.Color(1, 1, 1), k * 0.9, 0, 0);
    sprite(A, rF * 1.2, 8, DOOM, k, 1, t);
    splash(T, rT, A, 6, k * (0.8 + 0.4 * flick(t, 9, 0.6, d.to)), DOOM, P.shield(d.to), d.f * 31 + Math.floor(t * 3), (t * 3) % 1);
  }

  // 导弹：二次贝塞尔路径，起点朝船头外偏，终点是目标当前位置
  function missile(P, m, j, t) {
    const fx = P.rec.units[m.f].fx?.[m.k] || { c: 0xffcf4a, er: 80, v: 4000 };
    const S = P.posAt(m.f, m.t0, vA);
    const T = P.at(m.to);
    if (!S || !T) return;
    const dist = S.distanceTo(T);
    const t1 = m.t1 ?? (m.t0 + Math.max(0.5, dist / (fx.v * KM)));
    const age = t - m.t0;
    const dur = Math.max(0.1, t1 - m.t0);
    const seed = j * 13 + 7;
    // 发射方向：船头朝向 + 随机上抬 / 侧偏
    const out = vC.set(hash(seed, 1) - 0.5, hash(seed, 2) * 0.8 + 0.2, 0.8).normalize();
    if (P.heading[m.f]) out.applyQuaternion(P.heading[m.f]);
    const ctrl = vD.copy(S).addScaledVector(out, Math.min(dist * 0.35, 4));
    const bez = (u, o) => o.set(0, 0, 0).addScaledVector(S, (1 - u) ** 2).addScaledVector(ctrl, 2 * u * (1 - u)).addScaledVector(T, u * u);
    const color = new THREE.Color(fx.c);
    // 发射口烟团（launcher/*_fx.black：puff.dds 粒子，0.38 秒内按 50 个 / 秒喷出，灰 0.28）
    if (age < 0.9) for (let k = 0; k < 4; k++) {
      const ak = age - k * 0.09;
      if (ak < 0 || ak > 0.8) continue;
      sprite(vB.copy(S).addScaledVector(out, ak * 0.15 + k * 0.02), 14 + ak * 40, 2, PUFF, 0.5 * (1 - ak / 0.8), 0);
    }
    if (t < t1) {
      const u = Math.min(0.995, age / dur);
      const head = bez(u, new THREE.Vector3());
      sprite(head, 12, 4, MISSILE, 1, 1, seed);
      sprite(head, 26, 6, FIRE, 0.45, 0);
      // 拖尾：最近 0.6 秒的路径
      let prev = head;
      for (let k = 1; k <= 5; k++) {
        const uu = Math.max(0, u - (0.12 * k) / dur);
        const p = bez(uu, new THREE.Vector3());
        ribbon(p, prev, 4, 1.6, TRAIL, 0.8 * (1 - (k - 1) / 5), 1);
        prev = p;
        if (uu <= 0) break;
      }
    } else if (m.hit) {
      const a = t - t1;
      if (a < 1.1) {
        const k = 1 - a / 1.1;
        const r = fx.er * 2;                       // 爆炸直径 = 2 × 爆炸半径
        sprite(T, r * (0.5 + a * 0.9) * fireScale(), 3, color, ccp.value ? Math.min(1, k * 1.6) : k, fireTile(a / 1.1), seed);
        sprite(T, r * 0.6, 3, new THREE.Color(1, 1, 1), k * k, 1, seed);
        if (a < 0.6 && P.shield(m.to)) shieldHit(T, P.radiusOf(m.to), vE.copy(S).sub(T).normalize(), a / 0.6, SHIELD, P.shield(m.to));
      }
    } else if (t - t1 < 0.4) {
      const p = bez(1, new THREE.Vector3());
      sprite(p, 20, 1.5, FIRE, 1 - (t - t1) / 0.4, 0);
    }
  }

  // 阵亡爆炸：白闪、火球、冲击波环
  function death(P, x, t) {
    const a = t - x.at;
    if (a < 0 || a > 3) return;
    const p = P.at(x.unit) || P.posAt(x.unit, x.at, vA);
    if (!p) return;
    const r = P.radiusOf(x.unit) / KM;               // 米
    const c = p.clone();
    if (a < 0.35) sprite(c, r * 7 * (0.5 + a * 2), 22, new THREE.Color(1, 0.95, 0.9), 1 - a / 0.35, 1, x.unit);
    for (let k = 0; k < 4; k++) {
      const off = vB.set(hash(x.unit, k, 1) - 0.5, hash(x.unit, k, 2) - 0.5, hash(x.unit, k, 3) - 0.5).multiplyScalar(r * KM * 1.2);
      const ak = a - k * 0.12;
      if (ak < 0) continue;
      sprite(vC.copy(c).add(off), r * (2 + ak * 1.6) * fireScale(), 10, FIRE, ccp.value ? Math.min(1, ak < 2.6 ? 1 : 0) : Math.max(0, 1 - ak / 2.6) * 0.9, fireTile(ak / 2.6), x.unit * 3 + k);
    }
    if (a < 1.8) sprite(c, r * (3 + a * 9) * (ccp.value ? 1.4 : 1), 14, new THREE.Color(1, 0.8, 0.55), (1 - a / 1.8) * (ccp.value ? 0.7 : 0.4), 3, ccp.value ? a * 0.3 : 0);
    // 游戏火团：几团慢慢胀大、转动、按色带由白热转暗红后烧散
    if (ccp2.value) for (let k = 0; k < 3; k++) {
      const ak = a - 0.05 - k * 0.18;
      if (ak < 0 || ak > 2.4) continue;
      const off = vB.set(hash(x.unit, k, 5) - 0.5, hash(x.unit, k, 6) - 0.5, hash(x.unit, k, 7) - 0.5).multiplyScalar(r * KM * 0.8);
      sprite(vC.copy(c).add(off), r * (2.6 + ak * 1.8 + k * 0.5), 12, FIRE, 0.9, 5 + Math.min(99, Math.floor(ak / 2.4 * 99)) / 100, hash(x.unit, k, 8) * 6 + ak * 0.25 * (k % 2 ? 1 : -1));
    }
  }

  return {
    // P：{ rec, frames 访问, at(i) 当前位置, posAt(i, t, out), radiusOf(i)（千米）, heading[], shield(i) 护盾还在时 = i + 1、没了 = 0,
    //      shell(i, out) 护盾椭球的变换矩阵（单位球 → 世界，千米；没有椭球数据时返回 null）}
    update(t, P, kills) {
      curP = P;
      renderer.getDrawingBufferSize(res);
      ribbons.begin(); sprites.begin(); ewBeams.begin();
      if (cfx && P.camera) cfx.begin(P.camera, t);
      time.value = performance.now() / 1000;
      nShield = 0;
      const rec = P.rec, dt = rec.dt;
      const k = Math.floor(t / dt);
      ewar(P, t, k);
      // 炮台：最近 1.6 秒的开火
      for (let back = 0; back <= 4; back++) {
        const fr = rec.frames[k - back];
        if (!fr) continue;
        const s = fr.shots;
        for (let j = 0; j < s.length; j += 4) {
          const from = s[j], to = s[j + 1], kind = s[j + 2], g = s[j + 3];
          if (!P.at(from) || !P.at(to)) continue;
          const seed = (k - back) * 977 + j;
          const tf = fr.t - dt + hash(seed, 11) * dt;
          if (t < tf) continue;
          if (kind === 2) {
            const age = t - tf;
            if (age < 0.8) sprite(P.at(to), P.radiusOf(to) * 1800, 12, REP, (1 - age / 0.8) * 0.5, 0);
            continue;
          }
          // 立体炸弹扫到目标（客户端 EMPWave：命中在 500 毫秒 × 距离 / 范围 之后冒出来，波扩散到那里才有冲击）
          if (kind === 3) {
            const e = rec.units[from].ew?.find((y) => y[0] === g), R = e?.[3] || 5000;
            const t0 = fr.t - dt + 0.5 * Math.min(1, P.at(from).distanceTo(P.at(to)) / KM / R);
            const age = t - t0;
            if (age >= 0 && age < 0.6) splash(P.at(to), P.radiusOf(to), P.at(from), 8, 1 - age / 0.6, SHIELD, P.shield(to), seed, age);
            continue;
          }
          const fx = rec.units[from].fx?.[g];
          if (!fx || fx.w === 'missile' || fx.w === 'doom') continue;
          turretShot(P, fx, from, to, kind === 1, tf, t, seed, g);
        }
      }
      // 导弹：按发射时间排序，看最近 45 秒发射的
      const M = rec.missiles;
      let lo = 0, hi = M.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (M[mid].t0 <= t) lo = mid + 1; else hi = mid; }
      for (let j = lo - 1; j >= 0 && M[j].t0 > t - 45; j--) {
        const m = M[j];
        if (m.t1 != null && t > m.t1 + 1.2) continue;
        missile(P, m, j, t);
      }
      for (const d of rec.dooms || []) doomsday(P, d, t);
      for (const x of kills || []) death(P, x, t);
      ribbons.end(); sprites.end(); ewBeams.end();
      cfx?.end();
      shields.count = nShield;
      shields.instanceMatrix.needsUpdate = true;
      iDir.needsUpdate = iCol.needsUpdate = true;
    },
    ready: () => ccpReady,
    // 开局预热（加载画面里每帧问一次，true = 好了）：这一局记录里出现的装备类客户端特效（电子战光束、范围类、微跳）先加载并各建一份常驻实例，
    // 拦截泡发生器的球也先建好（不可见），着色器由 sim-3d 统一在加载画面里编译（renderer.compile 会遍历到不可见的物体）
    warm(rec) {
      let ok = true;
      (rec?.units || []).forEach((u, i) => {
        for (const [, kind] of u.ew || []) {
          if (kind === 'bubble') {
            if (!bubbles.has(i)) { const b = new THREE.Mesh(bubbleGeo, bubbleMat); b.renderOrder = 3; b.visible = false; scene.add(b); bubbles.set(i, b); }
            continue;
          }
          if (!cfx) continue;
          const file = CFX.has(kind) ? CFX_FILE[kind] || kind : AREA.test(kind) ? kind : null;
          if (file && !cfx.warm(file)) ok = false;
          if (kind === 'mjd' && !cfx.warm('mjdjump')) ok = false;
        }
      });
      return ok;
    },
    dispose() { cfx?.dispose(); for (const b of bubbles.values()) scene.remove(b); for (const b of fieldMeshes.values()) { scene.remove(b); b.material.dispose(); } bubbleGeo.dispose(); bubbleMat.dispose(); tex.dispose(); for (const t of [cSpr, cExp, cBeam, cTur, cShd, cRamp, cFire]) t.value?.dispose(); ribbons.mesh.geometry.dispose(); sprites.mesh.geometry.dispose(); ewBeams.mesh.geometry.dispose(); shieldGeo.dispose(); },
  };
}
