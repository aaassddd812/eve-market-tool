// ===== 战场模拟：开火、导弹、命中、爆炸特效（three.js）=====
// 按 sim-engine 记录的开火（[开火方, 目标, 0 未命中 | 1 命中 | 2 遥修, 第几门武器]）和每门武器的特效信息（rec.units[i].fx）画：
//   激光：脉冲是短促闪光、集束是持续光束，颜色按晶体；混合：疾速炮一串等离子弹、磁轨炮一道细长光迹；
//   射弹：自动加农炮连串曳光弹、火炮大炮口闪光 + 重型曳光弹；三神裔分解器持续光束、沃顿投射器电弧；
//   导弹：先朝外飞再拐向目标，带尾焰和拖尾，爆炸大小 = 导弹爆炸半径，颜色按主伤害类型；
//   命中：护盾还在时护盾泡上亮起一片波纹，打穿护盾后是船体上的火光与火花；未命中的从目标旁边擦过去；
//   阵亡：白闪、火球、冲击波环。尺寸按真实米数，拉远时有最小像素宽度，远看也能看到交火。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const SIZE_M = [0, 1, 2, 4, 10];                 // 武器尺寸（小 / 中 / 大 / 超大）→ 宽度倍数
const REP = new THREE.Color(0x3ee08f);
const SHIELD = new THREE.Color(0x7fc4ff);
const FIRE = new THREE.Color(0xffa04a);
const MISSILE = new THREE.Color(0xffe2a8);
const TRAIL = new THREE.Color(0.95, 0.78, 0.55);
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

export function createFx(scene, renderer) {
  const res = new THREE.Vector2(1, 1);
  const tex = atlas();
  // 光束 / 曳光：屏幕空间的带子，宽度按米换算成像素、不小于 minpx；style 1 为拖尾（尾部渐隐）
  const ribbonMat = new THREE.ShaderMaterial({
    uniforms: { res: { value: res } },
    vertexShader: `${LOG_V}
      attribute vec3 pa; attribute vec3 pb; attribute vec2 corner; attribute vec4 col; attribute vec3 wst; uniform vec2 res;
      varying vec2 vUv; varying vec4 vCol; varying float vStyle;
      void main() {
        mat4 pv = projectionMatrix * viewMatrix;
        vec4 ca = pv * vec4(pa, 1.0), cb = pv * vec4(pb, 1.0);
        float e = 1e-5;
        if (ca.w < e && cb.w < e) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        if (ca.w < e) ca = mix(ca, cb, (e - ca.w) / (cb.w - ca.w));
        if (cb.w < e) cb = mix(cb, ca, (e - cb.w) / (ca.w - cb.w));
        vec2 sa = ca.xy / ca.w * res, sb = cb.xy / cb.w * res;
        vec2 d = sb - sa; d = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
        vec2 nr = vec2(-d.y, d.x);
        vec4 c = corner.x < 0.5 ? ca : cb;
        float px = wst.x * projectionMatrix[1][1] * res.y * 0.5 / c.w;
        float w = max(px, wst.y);
        c.xy += nr * corner.y * w / res * c.w;
        gl_Position = c;
        vUv = corner; vCol = col; vCol.a *= clamp(px / max(wst.y, 1e-3) * 0.4 + 0.65, 0.65, 1.0); vStyle = wst.z;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      varying vec2 vUv; varying vec4 vCol; varying float vStyle;
      void main() {
        #include <logdepthbuf_fragment>
        float a = 1.0 - abs(vUv.y);
        float core = pow(a, 5.0), glow = pow(a, 1.6) * 0.55;
        float k = (core + glow) * vCol.a;
        if (vStyle > 0.5) k *= vUv.x * vUv.x;
        gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), core * 0.65) * k, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ribbons = quadBatch({ pa: 3, pb: 3, corner: 2, col: 4, wst: 3 }, ribbonMat);
  ribbons.mesh.renderOrder = 3;
  scene.add(ribbons.mesh);

  // 精灵（闪光、火球、冲击波、导弹头）：始终面向镜头，尺寸按米、不小于 minpx
  const spriteMat = new THREE.ShaderMaterial({
    uniforms: { res: { value: res }, map: { value: tex } },
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
      uniform sampler2D map; varying vec2 vUv; varying vec4 vCol; varying float vTile;
      void main() {
        #include <logdepthbuf_fragment>
        float a = texture2D(map, vec2((vTile + vUv.x) / 4.0, vUv.y)).a * vCol.a;
        gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), a * a * 0.35) * a, 1.0);
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
    vertexShader: `${LOG_V}
      attribute vec3 iDir; attribute vec4 iCol; varying vec3 vN; varying vec3 vDir; varying vec4 vCol; varying vec3 vView;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(position); vDir = iDir; vCol = iCol; vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `${LOG_F}
      varying vec3 vN; varying vec3 vDir; varying vec4 vCol; varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        float d = dot(vN, vDir);
        float age = vCol.a;                                   // 0 → 1
        float spot = smoothstep(0.55 - age * 0.5, 1.0, d);
        float wave = exp(-pow((d - (1.0 - age * 1.1)) * 9.0, 2.0)) * 0.8;
        float hex = 0.75 + 0.25 * sin(vN.x * 60.0) * sin(vN.y * 60.0) * sin(vN.z * 60.0);
        float a = (spot * (1.0 - age) * 0.9 + wave * (1.0 - age)) * hex;
        a *= 0.55 + 0.45 * abs(dot(vN, vView));
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
  let nShield = 0;

  // 绘制工具
  const ribbon = (a, b, widthM, minPx, color, alpha, streak = 0) => ribbons.push({ pa: [a.x, a.y, a.z], pb: [b.x, b.y, b.z], col: [color.r, color.g, color.b, alpha], wst: [widthM * KM, minPx, streak] });
  const sprite = (p, sizeM, minPx, color, alpha, tile = 0, rot = 0) => sprites.push({ center: [p.x, p.y, p.z], col: [color.r, color.g, color.b, alpha], sz: [sizeM * KM, minPx, tile, rot] });
  function shieldHit(center, rKm, dir, age, color = SHIELD) {
    if (nShield >= MAXS) return;
    tmp.position.copy(center);
    tmp.quaternion.identity();
    tmp.scale.setScalar(rKm);
    tmp.updateMatrix();
    shields.setMatrixAt(nShield, tmp.matrix);
    iDir.setXYZ(nShield, dir.x, dir.y, dir.z);
    iCol.setXYZW(nShield, color.r, color.g, color.b, Math.min(1, age));
    nShield++;
  }

  // 命中效果：护盾波纹 + 表面闪光，或船体火光 + 火花
  function impact(S, at, toPos, rKm, fromPos, size, age, color, shieldUp, seed) {
    if (age < 0 || age > 0.8) return;
    const dir = vD.copy(fromPos).sub(toPos).normalize();
    const f = 1 - age / 0.8;
    if (shieldUp) {
      shieldHit(toPos, rKm * 1.25, dir, age / 0.8);
      sprite(vE.copy(toPos).addScaledVector(dir, rKm * 1.25), 20 * size, 2.5, SHIELD, f * 0.9, 1, seed * 6);
    } else {
      const p = vE.copy(toPos).addScaledVector(dir, rKm * 0.55);
      sprite(p, 30 * size * (0.6 + age), 2.5, FIRE, f, 2, seed * 6);
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

  // 一发炮台射击
  function turretShot(P, fx, from, to, hit, tf, t, seed) {
    const age = t - tf;
    const s = SIZE_M[fx.s || 1];
    const color = new THREE.Color(fx.c);
    const A = hardpoint(new THREE.Vector3(), from, seed % 8, P);
    const rT = P.radiusOf(to);
    const Tp = P.at(to);
    const B = aimPoint(new THREE.Vector3(), A, Tp, from, to, seed, hit, rT);
    const dist = A.distanceTo(B);
    const shieldUp = P.shield(to);
    switch (fx.w) {
      case 'pulse': {
        if (age < 0.32) { ribbon(A, B, 5 * s, 1.4, color, (1 - age / 0.32) * (0.8 + 0.2 * Math.sin(age * 90))); sprite(A, 25 * s, 2, color, 1 - age / 0.32, 1); }
        if (hit) impact(null, 0, Tp, rT, A, s, age - 0.05, color, shieldUp, seed);
        break;
      }
      case 'beam': case 'disint': {
        const life = fx.w === 'disint' ? 1.4 : 1.1;
        if (age < life) {
          const k = Math.min(1, age / 0.08) * Math.min(1, (life - age) / 0.25);
          ribbon(A, B, (fx.w === 'disint' ? 7 : 6) * s * (0.85 + 0.15 * Math.sin(age * 40 + seed)), 1.4, color, k);
          sprite(A, 22 * s, 2, color, k * 0.8, 1, age * 3);
          if (hit) impact(null, 0, Tp, rT, A, s * 0.8, (age % 0.4), color, shieldUp, seed + Math.floor(age / 0.4));
        }
        break;
      }
      case 'blaster': case 'auto': {
        const n = fx.w === 'auto' ? 3 : 2, speed = fx.w === 'auto' ? 7 : 9;   // 千米 / 秒（画面速度）
        const travel = Math.min(0.5, Math.max(0.08, dist / speed));
        for (let b = 0; b < n; b++) {
          const ab = age - b * 0.07;
          if (ab < 0) continue;
          const u = ab / travel;
          if (u <= 1) {
            const head = vC.copy(A).lerp(B, u), tail = vD.copy(A).lerp(B, Math.max(0, u - Math.min(0.35, (fx.w === 'auto' ? 0.12 : 0.2) * s / Math.max(dist, 0.01))));
            ribbon(tail, head, (fx.w === 'auto' ? 2.5 : 5) * s, 1.2, color, 1, 1);
            if (fx.w === 'blaster') sprite(head, 10 * s, 1.5, color, 0.9, 0);
          }
          if (b === 0 && ab < 0.12) sprite(A, (fx.w === 'auto' ? 18 : 22) * s, 2, fx.w === 'auto' ? FIRE : color, 1 - ab / 0.12, 1, seed);
          if (hit && b < 2) impact(null, 0, Tp, rT, A, s * 0.7, ab - travel, color, shieldUp, seed + b);
        }
        break;
      }
      case 'rail': case 'arty': {
        const speed = fx.w === 'rail' ? 14 : 6;
        const travel = Math.min(0.5, Math.max(0.08, dist / speed));
        const u = age / travel;
        if (fx.w === 'rail' && age < 0.45) ribbon(A, vC.copy(A).lerp(B, Math.min(1, u)), 2.5 * s, 1, color, (1 - age / 0.45) * 0.7, 0);
        if (u <= 1) ribbon(vD.copy(A).lerp(B, Math.max(0, u - Math.min(0.25, (fx.w === 'rail' ? 0.5 : 0.3) * s / Math.max(dist, 0.01)))), vC.copy(A).lerp(B, u), (fx.w === 'rail' ? 4 : 7) * s, 1.4, color, 1, 1);
        if (age < (fx.w === 'arty' ? 0.3 : 0.15)) {
          const k = 1 - age / (fx.w === 'arty' ? 0.3 : 0.15);
          sprite(A, (fx.w === 'arty' ? 70 : 30) * s, 3, fx.w === 'arty' ? FIRE : color, k, 1, seed);
          if (fx.w === 'arty') sprite(A, 90 * s * (1 + age * 2), 3, FIRE, k * 0.6, 2, seed);
        }
        if (hit) impact(null, 0, Tp, rT, A, s * (fx.w === 'arty' ? 1.5 : 1), age - travel, color, shieldUp, seed);
        break;
      }
      case 'vorton': {
        if (age < 0.35) {
          const k = 1 - age / 0.35, segs = 7, phase = Math.floor(age / 0.05);
          let prev = A.clone();
          for (let j = 1; j <= segs; j++) {
            const p = A.clone().lerp(B, j / segs);
            if (j < segs) p.add(vE.set(hash(seed, j, phase) - 0.5, hash(seed, j + 9, phase) - 0.5, hash(seed, j + 19, phase) - 0.5).multiplyScalar(dist * 0.08));
            ribbon(prev, p, 3 * s, 1.2, color, k);
            prev = p;
          }
        }
        if (hit) impact(null, 0, Tp, rT, P.at(from), s, age, color, shieldUp, seed);
        break;
      }
      default:
        if (age < 0.4) ribbon(A, B, 3 * s, 1.2, color, 1 - age / 0.4);
    }
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
        sprite(T, r * (0.5 + a * 0.9), 3, color, k, 2, seed);
        sprite(T, r * 0.6, 3, new THREE.Color(1, 1, 1), k * k, 1, seed);
        if (a < 0.6 && P.shield(m.to)) shieldHit(T, P.radiusOf(m.to) * 1.25, vE.copy(S).sub(T).normalize(), a / 0.6);
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
      sprite(vC.copy(c).add(off), r * (2 + ak * 1.6), 10, FIRE, Math.max(0, 1 - ak / 2.6) * 0.9, 2, x.unit * 3 + k);
    }
    if (a < 1.8) sprite(c, r * (3 + a * 9), 14, new THREE.Color(1, 0.8, 0.55), (1 - a / 1.8) * 0.4, 3, 0);
  }

  return {
    // P：{ rec, frames 访问, at(i) 当前位置, posAt(i, t, out), radiusOf(i)（千米）, heading[], shield(i) 护盾是否还在 }
    update(t, P, kills) {
      renderer.getDrawingBufferSize(res);
      ribbons.begin(); sprites.begin();
      nShield = 0;
      const rec = P.rec, dt = rec.dt;
      const k = Math.floor(t / dt);
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
            if (age < 1) ribbon(hardpoint(vA, from, 9, P), P.at(to), 6, 1.2, REP, (1 - age) * 0.7);
            continue;
          }
          const fx = rec.units[from].fx?.[g];
          if (!fx || fx.w === 'missile') continue;
          turretShot(P, fx, from, to, kind === 1, tf, t, seed);
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
      for (const x of kills || []) death(P, x, t);
      ribbons.end(); sprites.end();
      shields.count = nShield;
      shields.instanceMatrix.needsUpdate = true;
      iDir.needsUpdate = iCol.needsUpdate = true;
    },
    dispose() { tex.dispose(); ribbons.mesh.geometry.dispose(); sprites.mesh.geometry.dispose(); shieldGeo.dispose(); },
  };
}
