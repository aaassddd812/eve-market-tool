// 船体灯（客户端 Tr2LightManager 点光 / 聚光灯，SOF 挂在船上的那些；转换器导到 m/*.json 的 lights）
// 客户端：每帧收集所有灯 → 视锥外剔除 → 屏幕上直径（像素）< 7 剔除、7~12 渐亮（CUTOFF_PIXEL_SIZE 7、FADE_SIZE 5）→
//   亮度 × 半径（scaleBrightnessByRadius 默认开）→ 16 像素分块的灯表，船壳着色器逐盏算（DynamicLighting.fxh + 实机船壳 PS 2f06fc 的灯循环）。
// 这里：CPU 每帧挑屏幕上最大的 MAX 盏，转到观察空间塞进 uniform 数组；着色器逐盏循环（不分块）。
//   精灵灯闪烁（半径 × Blink）、面片灯渐变（亮度 × Fade）、聚光灯 / 光雾灯 × 推进器增益、activationStrength（死船 0.2）照客户端。
//   子特效（船体 children 的 EveChildContainer）里的灯：噪声闪动（Tr2Light：亮度 × (PerlinNoise1D(t × 频率, 2, 2, 八度) + 1) / 2 × 幅度）、
//     IES 灯型（Tr2LightProfileRes 1024×1 曲线，着色器按 u = 0.5 − 0.5·cos 取样后乘进衰减）。
//   推进器灯（EveBoosterUtilities AddBoosterLights）：每个喷口一盏，半径 × lerp(lightRadius, lightWarpRadius, 跃迁) × 推进强度，
//     颜色 lerp(lightColor, lightWarpColor, 跃迁) × 闪动（ComputeBoosterLightFlicker：128 项随机表线性插值）。
//   坐标：模型几何载入时镜像了 X（sim-ships.js），灯的位置、方向也镜像。
//   子特效灯的颜色由转换器按阵营色表求好（EveChildInheritProperties → Tr2CurveColorMixer，阵营灯 Tr2FactionLight）。
//   子特效里自动播放的曲线集驱动的颜色 / 亮度 / 半径（Tr2CurveScalar / Tr2CurveColor / Mixer / 表达式）：按 sim-curves.js 逐帧求值。
//   没做：灯光的阴影（客户端「阴影 高」时部分灯有阴影图集）、要游戏逻辑触发才播放的曲线集（playOnLoad false，用静态值）、Tr2TexturedPointLight。
import * as THREE from './vendor/three/three.module.min.js';
import { perlin1D, createGraph } from './sim-curves.js?v=1';

export const PL_MAX = 32;
const arr = () => Array.from({ length: PL_MAX }, () => new THREE.Vector4());
// 船壳材质读这些（sim-ships.js）：P = 观察空间位置（千米）+ 半径（米），C = 颜色（已 × π，three 的光照约定）+ 内半径（米），
//   D = 观察空间方向 + cos 外角（点光 0），E.x = cos 内角
export const SHIP_LIGHTS = { n: { value: 0 }, p: { value: arr() }, c: { value: arr() }, d: { value: arr() }, e: { value: arr() } };

// EveSpaceObjectAttachmentUtils
function blink(rate, phase, min, max, t) {
  if (rate === 0) return min;
  const f = (t * rate + phase) % 1;
  let peak = 0.05 * rate;
  const end = peak * 4;
  if (peak < 0.0001) peak = 1;
  let r = 0;
  if (f < peak) r = f / peak;
  else if (f < end) r = 1 - (f - peak) / (end - peak);
  return (max - min) * r + min;
}
function fade(type, rate, phase, t) {
  switch (type) {
    case 1: return blink(rate, phase, 0, 1, t);
    case 2: return ((t + phase) * rate) % 1;
    case 3: return 1 - (((t + phase) * rate) % 1);
    case 4: return (Math.sin(((t * rate * Math.PI * 2) % (Math.PI * 2)) + phase * Math.PI * 2) + 1) / 2;
    default: return 1;
  }
}

// 噪声：TriMath PerlinNoise1D(x, 2, 2, 八度)（sim-curves.js）
const perlin1D_22 = (x, oct) => perlin1D(x, 2, 2, oct);
// 推进器灯闪动表（客户端是 rand() / RAND_MAX，这里固定种子）
const FLK = (() => { let s = 12345; return Array.from({ length: 128 }, () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) / 65535); })();
function flicker(phase, amp, freq, t) {
  const p = (phase + t) * freq, i = Math.floor(p), k = p - i;
  return 1 + amp * 2 * (FLK[i & 127] * (1 - k) + FLK[(i + 1) & 127] * k) - amp;
}

// IES 灯型：每种一行 128 点（转换器降采样过），横坐标 u = 0.5 − 0.5·cos
const IES_W = 128, IES_H = 32;
const iesRows = new Map();
// 半精度：WebGL2 里半精度浮点贴图都能线性过滤（单精度要 OES_texture_float_linear）
export const IES_TEX = new THREE.DataTexture(new Uint16Array(IES_W * IES_H), IES_W, IES_H, THREE.RedFormat, THREE.HalfFloatType);
IES_TEX.minFilter = IES_TEX.magFilter = THREE.LinearFilter; IES_TEX.wrapS = IES_TEX.wrapT = THREE.ClampToEdgeWrapping;
IES_TEX.needsUpdate = true;
function iesRow(path, data) {
  if (iesRows.has(path)) return iesRows.get(path);
  if (iesRows.size >= IES_H) return 0;
  const r = iesRows.size;
  for (let i = 0; i < IES_W; i++) IES_TEX.image.data[r * IES_W + i] = THREE.DataUtils.toHalfFloat(data[i] || 0);
  IES_TEX.needsUpdate = true;
  iesRows.set(path, r + 1);
  return r + 1;
}

const M = new THREE.Matrix4(), N3 = new THREE.Matrix3(), V = new THREE.Vector3(), W = new THREE.Vector3(), D = new THREE.Vector3(), cam = new THREE.Vector3(), fwd = new THREE.Vector3();
const frustum = new THREE.Frustum(), PV = new THREE.Matrix4(), sph = new THREE.Sphere();
const pick = [];

// list：[{ mesh, def, wf }]（InstancedMesh + 模型定义 + 每个实例是否在跃迁）；实例颜色 g = activationStrength，b = 推进器亮度（sim-3d 写的）
export function updateShipLights(list, camera, w, h, t) {
  camera.updateMatrixWorld();
  PV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(PV);
  camera.getWorldPosition(cam); camera.getWorldDirection(fwd);
  const halfW = (w / 2) * camera.projectionMatrix.elements[0];
  pick.length = 0;
  for (const { mesh, def, wf } of list) {
    const L = def.lights;
    if (!L?.length || !mesh?.visible || !mesh.count) continue;
    const ic = mesh.instanceColor?.array, bl = def.bl;
    if (def.ies && !def.iesRow) def.iesRow = def.ies.map(([p, d]) => iesRow(p, d));
    // 曲线动画（转换器导出的绑定图，sim-curves.js）：行号 → [行号, 绑定, 静态色, 静态亮度, 静态半径, 静态内半径, parentScale]
    if (def.anim && !def.animG) { def.animG = createGraph(def.anim); def.laOf = new Map(def.anim.la.map((e) => [e[0], e])); }
    for (let c = 0; c < mesh.count; c++) {
      mesh.getMatrixAt(c, M);
      const act = ic ? ic[c * 3 + 1] : 1, boost = ic ? ic[c * 3 + 2] : 1;
      if (act <= 0) continue;
      const s = Math.hypot(M.elements[0], M.elements[1], M.elements[2]);   // 米 → 千米
      const warp = wf ? wf[c] || 0 : 0;
      let actx = null;
      for (let j = 0; j < L.length; j++) {
        const l = L[j];
        let R = l[3], inner = l[4], k = act, cr = l[5], cg = l[6], cb = l[7];
        if (l[13] === 1) { const b = blink(l[14], l[15], l[16], l[17], t); R *= b; inner *= b; }
        else if (l[13] === 2) k *= fade(l[14], l[15], l[16], t);
        else if (l[13] === 3) k *= boost;
        else if (l[13] === 4) {
          if (!bl) continue;
          R *= (bl.r * (1 - warp) + bl.wr * warp) * boost;
          const f = flicker(l[14], bl.fa, bl.ff, t);
          cr = (bl.c[0] * (1 - warp) + bl.wc[0] * warp) * f; cg = (bl.c[1] * (1 - warp) + bl.wc[1] * warp) * f; cb = (bl.c[2] * (1 - warp) + bl.wc[2] * warp) * f;
        } else if (l[13] === 5) k *= ((perlin1D_22((t + c * 7.31) * l[15], l[16]) + 1) / 2) * l[14];
        if (R <= 0 || k <= 0) continue;
        W.set(-l[0], l[1], l[2]).applyMatrix4(M);
        const Rk = R * s;
        sph.set(W, Rk);
        if (!frustum.intersectsSphere(sph)) continue;
        // TriFrustum::GetPixelSizeAccross
        V.subVectors(W, cam);
        let size;
        if (V.lengthSq() < Rk * Rk) size = Infinity;
        else size = (Rk / Math.max(1e-5 * s, V.dot(fwd))) * halfW * 2;
        if (size <= 7) continue;
        // 曲线动画：行里的半径是采样最大值（只用来剔除），这里按曲线集时间（载入后秒数 × scale）求出这一刻的颜色 / 亮度 / 半径
        const an = def.laOf?.get(j);
        if (an) {
          actx ||= def.animG.make(t + c * 7.31, c);
          const [, B, c0, br0, R0, ri0, ps] = an;
          const one = (v) => (typeof v === 'number' ? v : v[0]);
          let col = B.color ? actx.pull(B.color) : c0; if (typeof col === 'number') col = [col, col, col];
          const br = B.brightness ? one(actx.pull(B.brightness)) : br0;
          R = (B.radius ? one(actx.pull(B.radius)) : R0) * ps; inner = (B.innerRadius ? one(actx.pull(B.innerRadius)) : ri0) * ps;
          cr = col[0] * br; cg = col[1] * br; cb = col[2] * br;
          if (!(R > 0) || Math.max(cr, cg, cb) <= 0) continue;
        }
        const dim = Math.min((size - 7) / 5, 1) * R * k;
        pick.push({ size, x: W.x, y: W.y, z: W.z, R, inner, r: cr * dim, g: cg * dim, b: cb * dim, l, M: M.clone(), ies: l[18] ? def.iesRow?.[l[18] - 1] || 0 : 0 });
      }
    }
  }
  pick.sort((a, b) => b.size - a.size);
  const n = Math.min(PL_MAX, pick.length);
  const U = SHIP_LIGHTS;
  for (let i = 0; i < n; i++) {
    const q = pick[i], l = q.l;
    V.set(q.x, q.y, q.z).applyMatrix4(camera.matrixWorldInverse);
    U.p.value[i].set(V.x, V.y, V.z, q.R);
    U.c.value[i].set(q.r * Math.PI, q.g * Math.PI, q.b * Math.PI, q.inner);
    if (l[11] > 0) {
      N3.setFromMatrix4(q.M);
      D.set(-l[8], l[9], l[10]).applyMatrix3(N3).transformDirection(camera.matrixWorldInverse);
      U.d.value[i].set(D.x, D.y, D.z, l[11]);
      U.e.value[i].set(l[12], q.ies, 0, 0);
    } else U.d.value[i].set(0, 0, 0, 0);
  }
  U.n.value = n;
}
export function clearShipLights() { SHIP_LIGHTS.n.value = 0; }
