// 镜头周围的太空尘埃：照客户端 sceneManager.ApplySolarsystemAttributes 挂在镜头上的 res:/dx9/scene/dustfield.red。
// 对象（dustfield.black）：EveChildParticleSphere —— 半径 512 米、最多 512 颗，size 两个分量各在 0.1~0.3 之间随机，
//   positionShiftMin 500 / Max 10；网格 UnitPlane（±0.5 的方片）实例化，加色区（ONE, ONE），效果 dustfield.fx：
//   SpriteFactors (0.5, 0.25, 亮度, 0)、Color1 = Color2 = 0.107、Color3 = 0.016、ColorMidpoint 0.05、TexMap = texture/particle/whiteglobe.dds（sRGB）。
//   绑定：VelocityStretch = 自己船速度（米 / 秒）× 0.1；SpriteFactors.z = positionShift（归一化）。
// 模拟（trinity/Eve/SpaceObject/Children/EveChildParticleSphere.cpp）：球心 = 镜头位置，尘埃存球心坐标（米）、在世界里不动——
//   每帧所有尘埃加上「上一帧球心 − 这一帧球心」；|p|² / R² 存进 lifetime，≥ 1（出了球）就重新生成：
//   随机方向，距离 = minD + √rand ×(R − minD)，minD = max(0, R − 球心位移)，最多试 10 次要落在上一帧的球外（即刚进入的那块）；
//   第 10 次或球心没动时距离 = R × √rand。速度元素 = 自己船速度的单位方向，粒子系统每帧位置 += 速度 × dt（每秒漂 1 米）。
//   positionShift = 球心这一帧的位移（米），归一化 = clamp((位移 − 500) / (10 − 500))：一帧 10 米以内全亮、500 米以上（跃迁）不见，
//   升降速度 1000 / 秒（基本是瞬间）。只在镜头看着自己的船时显示（spaceCamera._LookingAtSelf / _LookingAtOther 切 display）。
// 着色器（dustfield.sm_hi 反汇编）：
//   VS：视空间位置 v（米，球心就在镜头上，只剩旋转）；屏幕上的速度方向 = 投影后 xy 的差归一化（为 0 时用 (0.01, 0.01)）；
//     距离系数 = 0.2274 × ((|v|² + 1) × sin(半视角))^0.185，角点 = size(按 lifetime 在两个分量间插值) × 方片角点，
//     再 × lerp(1, 距离系数, SpriteFactors.y)；角点在屏幕速度方向上的投影 k，位置 += 视空间速度方向 × min(VelocityStretch, 250) × k（假运动模糊）；
//     颜色：lifetime ≤ Midpoint 时 lerp(C1, C2, lt / mid)，否则 lerp(C2, C3, (lt − mid) / (1 − mid))；
//     VelocityStretch > 100 时 ÷ (VelocityStretch × 0.01)，≤ 10 时 × VelocityStretch × 0.1（停船看不见）；最后 × SpriteFactors.z。
//   PS：贴图 × 颜色 × (1 + SpriteFactors.x × (贴图 a − 1))，结尾线性 → sRGB（场景缓冲存 sRGB 编码值，和客户端一样）。
// 坐标：场景坐标 = 客户端坐标；长度按米算，投影前换成千米。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const R = 512, N = 512, SHIFT_MIN = 500, SHIFT_MAX = 10, SHIFT_SPEED = 1000;
const SIZE = [0.1, 0.3];
const SF = [0.5, 0.25];
const C1 = [0.10702309757471085, 0.10702309757471085, 0.10702309757471085, 0], C2 = C1, C3 = [0.0159962996840477, 0.0159962996840477, 0.0159962996840477, 0], MID = 0.05;

// fxDir：assets/eveui/fx/（tools/ui-assets/fetch.mjs --starfield 转出 dustfield/whiteglobe.png）
export function createDustfield(fxDir) {
  const tex = new THREE.TextureLoader().load(`${fxDir}dustfield/whiteglobe.png?v=1`);
  tex.colorSpace = THREE.SRGBColorSpace;   // dustfield.fx 的 TexMap 带 Tr2sRGB
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;   // 采样器 EveSceneFogSampler：三线性、夹边

  const pos = new Float32Array(N * 3), lt = new Float32Array(N), size = new Float32Array(N * 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2));
  geo.setIndex([2, 1, 3, 0, 1, 2]);
  const aPos = new THREE.InstancedBufferAttribute(pos, 3), aLt = new THREE.InstancedBufferAttribute(lt, 1), aSize = new THREE.InstancedBufferAttribute(size, 2);
  for (const a of [aPos, aLt, aSize]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', aPos); geo.setAttribute('iLt', aLt); geo.setAttribute('iSize', aSize);
  geo.instanceCount = 0;

  const v4 = (a) => new THREE.Vector4(...a);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tex: { value: tex }, velDir: { value: new THREE.Vector3() }, stretch: { value: 0 }, SF: { value: new THREE.Vector3(SF[0], SF[1], 0) },
      C1: { value: v4(C1) }, C2: { value: v4(C2) }, C3: { value: v4(C3) }, mid: { value: MID },
    },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 iPos; attribute float iLt; attribute vec2 iSize;
      uniform vec3 velDir, SF; uniform float stretch, mid; uniform vec4 C1, C2, C3;
      varying vec4 vCol; varying vec2 vUv;
      void main() {
        vec4 r0 = vec4(mat3(viewMatrix) * iPos, 1.0);
        vec3 vd = mat3(viewMatrix) * velDir;
        vec2 d2 = vec2(projectionMatrix[0][0] * vd.x, projectionMatrix[1][1] * vd.y);
        if (d2.x == 0.0 && d2.y == 0.0) d2 = vec2(0.01);
        d2 = normalize(d2);
        float df = pow(abs(dot(r0, r0) * sin(atan(1.0 / projectionMatrix[1][1]))), 0.185) * 0.2274;
        vec2 c = mix(iSize.x, iSize.y, iLt) * position.xy;
        c += SF.y * (c * df - c);
        float k = dot(c, d2);
        r0.xy += c;
        r0.xyz += vd * min(stretch, 250.0) * k;
        gl_Position = projectionMatrix * vec4(r0.xyz * ${KM.toFixed(6)}, 1.0);
        #include <logdepthbuf_vertex>
        vec4 col = iLt <= mid ? mix(C1, C2, iLt / mid) : mix(C2, C3, (iLt - mid) / (1.0 - mid));
        if (stretch > 100.0) col /= stretch * 0.01;
        if (stretch <= 10.0) col *= stretch * 0.1;
        vCol = col * SF.z;
        vUv = uv;
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D tex; uniform vec3 SF; varying vec4 vCol; varying vec2 vUv;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(tex, vUv);
        vec4 c = t * vCol * (1.0 + SF.x * (t.a - 1.0));
        vec3 o = max(c.rgb, 0.0);
        gl_FragColor = vec4(mix(1.055 * pow(o, vec3(0.416667)) - 0.055, o * 12.92, vec3(lessThan(o, vec3(0.003131)))), c.a);
      }`,
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;

  let alive = 0, prev = null, shiftN = 0;
  const ref = [0, 0, 0], dir = [0, 0, 0];
  // 重新生成第 i 颗（FillParticleData）
  function fill(i) {
    const refLen = Math.hypot(ref[0], ref[1], ref[2]);
    let x = 0, y = 0, z = 0, d = 0;
    for (let k = 0; k < 10; k++) {
      x = Math.random() - 0.5; y = Math.random() - 0.5; z = Math.random() - 0.5;
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      if (k === 9 || refLen === 0) { d = R * Math.sqrt(Math.random()); x *= d; y *= d; z *= d; }
      else {
        const minD = Math.max(0, R - refLen);
        d = minD + Math.sqrt(Math.random()) * (R - minD);
        x *= d; y *= d; z *= d;
        if (Math.hypot(x - ref[0], y - ref[1], z - ref[2]) < R) continue;
      }
      break;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    lt[i] = Math.min(1, d * d / R / R);
    size[i * 2] = SIZE[0] + Math.random() * (SIZE[1] - SIZE[0]);
    size[i * 2 + 1] = SIZE[0] + Math.random() * (SIZE[1] - SIZE[0]);
  }
  return {
    mesh,
    // center：镜头的世界坐标（米，双精度）；vel：自己船的速度（米 / 秒，[x, y, z]）；dt：秒；show：镜头看着自己的船
    update(center, vel, dt, show) {
      const sp = Math.hypot(vel[0], vel[1], vel[2]);
      dir[0] = sp > 0 ? vel[0] / sp : 0; dir[1] = sp > 0 ? vel[1] / sp : 0; dir[2] = sp > 0 ? vel[2] / sp : 0;
      // 第一帧：客户端的上一帧球心初值是 (R, 0, 0)，离镜头很远 → 整球按 √rand 铺满、这一帧亮度 0
      if (!prev) prev = [center[0] + 1e9, center[1], center[2]];
      ref[0] = prev[0] - center[0]; ref[1] = prev[1] - center[1]; ref[2] = prev[2] - center[2];
      const t = Math.min(1, Math.max(0, (Math.hypot(ref[0], ref[1], ref[2]) - SHIFT_MIN) / (SHIFT_MAX - SHIFT_MIN)));
      shiftN = t < shiftN ? Math.max(t, shiftN - dt * SHIFT_SPEED) : Math.min(t, shiftN + dt * SHIFT_SPEED);
      // ApplyConstraint：跟着世界走，出了球的重新生成
      for (let i = 0; i < alive; i++) {
        const x = pos[i * 3] + ref[0], y = pos[i * 3 + 1] + ref[1], z = pos[i * 3 + 2] + ref[2];
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        lt[i] = (x * x + y * y + z * z) / (R * R);
        if (lt[i] >= 1) fill(i);
      }
      // AddParticles：补满
      while (alive < N) fill(alive++);
      prev = [center[0], center[1], center[2]];
      // Tr2ParticleSystem::Update：位置 += 速度（单位方向）× dt
      for (let i = 0; i < alive; i++) { pos[i * 3] += dir[0] * dt; pos[i * 3 + 1] += dir[1] * dt; pos[i * 3 + 2] += dir[2] * dt; }
      geo.instanceCount = alive;
      aPos.needsUpdate = aLt.needsUpdate = aSize.needsUpdate = true;
      mat.uniforms.velDir.value.set(dir[0], dir[1], dir[2]);
      mat.uniforms.stretch.value = sp * 0.1;
      mat.uniforms.SF.value.z = shiftN;
      mesh.visible = Boolean(show);
    },
    // 镜头被拉到别处（换场景、过场）：下一帧当作第一帧
    reset() { prev = null; },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}
