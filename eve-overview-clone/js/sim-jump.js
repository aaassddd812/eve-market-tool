// ===== 深渊口袋之间过导管的过场（客户端 effects.JumpOutAbyssalBetween，只给自己的船）=====
// 数据：tools/ship-models/fx-jump.mjs 把两个 .black 转成 assets/eveui/fx/jump/{tunnel,jumpout}.json（对象树原样保留）+ 网格 + 贴图：
//   tunnel  = res:/fisfx/travel/abyssal/abyssal_tunnelbetween_01a（secondaryGraphicID 22073，挂 scene.warpTunnel 槽）
//   jumpout = res:/fisfx/module/jumpout_tr_t1a（graphicID 21014，ShipEffect，挂在自己的船上）
// 时间线照 eve/client/script/environment/effects/Jump.py（JumpOutAbyssalBetween、JumpTransitionAbyssalBetween /
//   JumpTransitionAbyssal / JumpTransitionTunnel、JumpOut.DelayedHide），镜头照 evefisfx/jumptransitioncamera.py、
//   evecamera/shaker.py、evecamera/animation.py、ui/camera/{baseCamera,baseSpaceCamera,jumpCamera,shipOrbitCamera}.py。
// 着色器照客户端 effect.dx11 的反汇编：jumptransition/jumptunneltransparent、jumptunneldistortion、specialfx/flarequad、
//   specialfx/ubershadertwosided（同 sim-cfx.js 的 uber2）。
// 坐标：客户端左手系，场景 = 客户端沿 X 镜像，单位千米；这里先在客户端坐标里算矩阵，再左乘镜像放进场景。
// 网格和贴图版权归 CCP。
import * as THREE from './vendor/three/three.module.min.js';
import { curveValue, applyBinding } from './sim-env.js?v=3';

const KM = 1 / 1000;
const LOG_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOG_F = '#include <common>\n#include <logdepthbuf_pars_fragment>\n';
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);

// ── 时间线（毫秒，0 = JumpOutAbyssalBetween.Start）──
export const JUMP_T = {
  // Jump.py JumpOut.DelayedHide：SleepSim(880) → OnSpecialFX('effects.Uncloak') → shipBall.model.display = False
  HIDE: 880,
  // JumpTransitionTunnel._PlayInitSequence：SleepSim(850) → initCS.Play()
  INIT: 850,
  // 同上，再 SleepSim(1500) → DoCameraShake(shakeJumpInit)
  SHAKE_INIT: 2350,
  // JumpTransitionAbyssal._DelayedStart：_PlayInitSequence 之后 SleepSim(initToStartDelay = 850) → FadeUIOut() →
  //   _PlayTunnelSequence：DoCameraShake(shakeJumpOut)、initCS.Stop()、startCS.Play()、Schedule(OutFOV(startCamDurationS = 1.0))
  TUNNEL: 3200,
  // _PlayTunnelSequence 末尾 SleepSim(500) → _PlayMidTransitionCurves：transition.ApplyDestinationScene()、mainCS.Play()；随后 ClearEnvironments()
  MID: 3700,
  // JumpOutAbyssalBetween.DelayedJumpTunnelBetween：Start() 后 SleepSim(5000) → shipModel.display = True → playerEffect.Stop()
  //   （JumpTransitionAbyssal.Stop：隧道从 scene.warpTunnel 挪进 scene.objects）
  SHOW: 5000,
  // JumpTransitionAbyssal.Stop：SleepSim(2000)、FreezeEnvironments(False)、SleepSim(500) → JumpTransitionTunnel.Stop：
  //   _EarlyCleanup 把隧道从场景里拿掉；ActivatePrimaryCamera（回到环绕镜头）；FadeUIIn()
  END: 7500,
  LOOK: 1000,           // AbyssalGateLookAnimation.Start → camera.TransitTo(...)，duration 默认 1.0 秒
  FOV_OUT: 1000,        // OutFOV(startCamDurationS = 1.0)
  UI_FADE: 1000,        // uicore.animations.FadeOut / FadeIn(uicore.layer.bracket, duration = 1)
  ORBIT_TRANSIT: 100,   // ShipOrbitCamera.OnActivated：duration = lastCamera.transitionDelay（JumpCamera：没开 subway 时 0.1 秒）
  FX_LIFE: 10000,       // jumpout_tr_t1a 的特效时长（FxSequencer 到时 Stop 移除）
};

// ── 曲线（Tr2CurveScalar 线性关键帧）──
export const linearCurve = (keys) => ({ _type: 'Tr2CurveScalar', keys: keys.map(([time, value]) => ({ time, value, interpolation: 1 })) });
const linear = linearCurve;
const smooth = (x) => { const s = Math.min(1, Math.max(0, x)); return s * s * (3 - 2 * s); };   // uiconst.ANIM_SMOOTH（两端切线 0 的 Hermite）

// ── 镜头抖动（evecamera/shaker.py + baseSpaceCamera._UpdateCameraNoiseOffset）──
// ShakeBehavior：{ key, scaleCurve, dampCurve, noiseScale = 0, noiseDamp = 1.1 }；每个镜头一个 ShakeController（各自的噪声状态）
export const shakeBehavior = (key, o = {}) => ({ key, noiseCurve: null, scaleCurve: null, dampCurve: null, noiseScale: 0, noiseDamp: 1.1, ...o });
const MAX_NOISE = 160;   // baseSpaceCamera.MAX_NOISE
const UP = new THREE.Vector3(0, 1, 0);
export function createShaker() {
  let cur = shakeBehavior(null), start = 0, scale = 0, damp = 1.1, nx = 0, ny = 0;
  const dir = new THREE.Vector3(), vx = new THREE.Vector3(), vy = new THREE.Vector3();
  const apply = (b, now) => { start = now; scale = b.noiseScale; damp = b.noiseDamp; };   // ShakeController._Apply（ResetCurveStartTime）
  return {
    get noiseScale() { return scale; },
    get key() { return cur.key; },
    // DoCameraShake
    shake(b, now) { apply(b, now); cur = b; },
    // EndCameraShake：只有当前行为的 key 相同才清掉
    end(key, now) { if (cur.key === key) this.clear(now); },
    clear(now) { cur = shakeBehavior(null); apply(cur, now); },
    // 每帧：now 毫秒、dt 秒（1 / fps），eye / at 同一坐标系；返回加到注视点上的偏移（写进 out），不抖返回 null
    offset(now, dt, eye, at, out) {
      const t = (now - start) / 1000;
      if (cur.scaleCurve) scale = curveValue(cur.scaleCurve, t);
      if (scale === 0) return null;
      if (cur.dampCurve) damp = curveValue(cur.dampCurve, t);
      nx = Math.max(-MAX_NOISE, Math.min(MAX_NOISE, (nx + damp * (Math.random() - 0.5)) / (1 + damp * dt)));
      ny = Math.max(-MAX_NOISE, Math.min(MAX_NOISE, (ny + damp * (Math.random() - 0.5)) / (1 + damp * dt)));
      const s = eye.distanceTo(at) / 100 * scale;   // GetZoomDistance() / 100 × noiseScale
      dir.subVectors(eye, at).normalize();          // GetLookAtDirection()
      vx.crossVectors(dir, UP);
      vy.crossVectors(dir, vx);
      return out.copy(vx).multiplyScalar(nx * s).addScaledVector(vy, ny * s);
    },
  };
}

// ── 过场的镜头、隐藏自己的船、界面淡出淡入、回调（时间线见 JUMP_T）──
// o = { gate: 导管位置（世界坐标，米）, gateYaw: 场景里导管绕 Y 的转角, gateR: 导管模型包围球半径（米）,
//       at0 / eye0: 开始时环绕镜头的注视点 / 位置（米）, fov0: 开始时的视角（弧度）, fovTarget: 回到环绕镜头后的视角（弧度）,
//       onMid(), onEnd() }
// frame(dt, shipW) 每帧调用（shipW = 自己的船这一帧的世界坐标（米），没画出来时 null），返回
//   { cam: { eye, at（含抖动）: 世界坐标（米）, fov（弧度）} 或 null（镜头已交还）, hideShip, ui: 界面不透明度 0–1, t: 过场时间（毫秒）, done }
export function createJumpSequence(o) {
  const V = THREE.Vector3, t0 = performance.now();
  const at0 = new V(...o.at0), eye0 = new V(...o.eye0);
  // AbyssalGateLookAnimation.Start：direction = rotation × (0, 0, 1) × (−boundingSphereRadius × 3)，at = _GetFocusPosition()（导管球位置；
  //   模型的 jump_center 定位点我们的数据里没有），eye = at + direction；camera.TransitTo(at, eye) 1 秒 ANIM_SMOOTH
  const gz = new V(Math.sin(o.gateYaw), 0, Math.cos(o.gateYaw));   // 导管 +Z（场景）
  const jAt = new V(...o.gate), jEye = jAt.clone().addScaledVector(gz, -3 * o.gateR);
  const zoom = eye0.distanceTo(at0);   // ShipOrbitCamera.GetInitialZoomDist：环绕镜头缓存的缩放距离
  const at = new V(), eye = new V(), noise = new V(), shipW = new V();
  let hasShip = false, rel = null, orbit = null, fov = o.fov0, fovStart = null, released = false, dead = false;
  // Jump.py _CreateCameraShakeCurves
  const damp = { _type: 'TriPerlinCurve', offset: 0.07, scale: 1, alpha: 0.75, speed: 4, N: 4 };
  const SH = {
    init: shakeBehavior('JumpInit', { noiseScale: 0.125, dampCurve: damp }),
    out: shakeBehavior('JumpOut', { scaleCurve: linear([[0, 0.125], [0.5, 4], [2.5, 1]]), dampCurve: damp }),
  };
  const shaker = createShaker();   // CAM_JUMP 镜头自己的 ShakeController
  const fired = {};
  const once = (k) => (fired[k] ? false : (fired[k] = true));
  // ApplyDestinationScene（3.7 秒）和 Stop（5 秒）按计时器触发，不依赖画面有没有在刷新
  const timers = [
    setTimeout(() => {
      // onMid 之后镜头不再固定在世界里：JumpCamera.Update 靠 ballpark 抵消自己船的位移，换场景后不再抵消 → 镜头跟着自己的船
      if (hasShip) rel = { at: at.clone().sub(shipW), eye: eye.clone().sub(shipW) };
      o.onMid?.();
    }, JUMP_T.MID),
    setTimeout(() => o.onEnd?.(), JUMP_T.SHOW),
  ];
  return {
    frame(dt, ship) {
      const t = performance.now() - t0;
      if (ship) { shipW.set(ship[0], ship[1], ship[2]); hasShip = true; }
      const hideShip = t >= JUMP_T.HIDE && t < JUMP_T.SHOW;
      const ui = t < JUMP_T.TUNNEL ? 1 : t < JUMP_T.END ? 1 - smooth((t - JUMP_T.TUNNEL) / JUMP_T.UI_FADE) : smooth((t - JUMP_T.END) / JUMP_T.UI_FADE);
      let cam = null;
      if (!released) {
        if (t < JUMP_T.END) {
          // CAM_JUMP：0–1 秒从环绕镜头过渡到看导管，之后固定（onMid 之后跟船）
          if (rel && hasShip) { at.copy(shipW).add(rel.at); eye.copy(shipW).add(rel.eye); } else if (!rel) {
            const s = smooth(t / JUMP_T.LOOK);
            at.lerpVectors(at0, jAt, s); eye.lerpVectors(eye0, jEye, s);
          }
          // OutFOV(1.0)：progress 0.3 之后 fov = lerp(起始, 2.2, 1 − (1 − q)²)，q = (p − 0.3) / 0.7
          if (t >= JUMP_T.TUNNEL) {
            fovStart ??= fov;
            const p = Math.min(1, (t - JUMP_T.TUNNEL) / JUMP_T.FOV_OUT), q = Math.max(0, (p - 0.3) / 0.7);
            fov = fovStart + (2.2 - fovStart) * (1 - (1 - q) ** 2);
          }
          if (t >= JUMP_T.SHAKE_INIT && once('si')) shaker.shake(SH.init, t0 + JUMP_T.SHAKE_INIT);
          if (t >= JUMP_T.TUNNEL && once('so')) shaker.shake(SH.out, t0 + JUMP_T.TUNNEL);
          const n = shaker.offset(t0 + t, dt, eye, at, noise);
          cam = { eye: eye.clone(), at: n ? at.clone().add(n) : at.clone(), fov };
        } else {
          // ActivatePrimaryCamera → ShipOrbitCamera.OnActivated(lastCamera = CAM_JUMP)：
          //   at1 = 自己的船，eye1 = at1 + 跳跃镜头的 GetLookAtDirection() × 缩放距离；Transit(..., duration = 0.1, smoothing = 0)
          //   fov = lastCamera.fov（2.2），SetFovTarget(原 fov)：每帧 fov += min(kFovSpeed(10) × 惯性倍率(1) / fps, 1) × 差值，再夹到 [minFov 0.8, maxFov 1.2]
          if (!orbit) {
            const dir = eye.clone().sub(at).normalize();
            orbit = { dir, atOff: at.clone().sub(shipW), eyeOff: eye.clone().sub(shipW).addScaledVector(dir, -zoom), fov };
          }
          const s = smooth((t - JUMP_T.END) / JUMP_T.ORBIT_TRANSIT);
          const a = shipW.clone().addScaledVector(orbit.atOff, 1 - s), e = shipW.clone().addScaledVector(orbit.dir, zoom).addScaledVector(orbit.eyeOff, 1 - s);
          const d = o.fovTarget - orbit.fov;
          if (Math.abs(d) > 1e-4) {
            let k = 10 * dt;
            if (Math.abs(d) < 0.001) k *= 0.001 / Math.abs(d);   // kFovStopDist
            orbit.fov = Math.min(1.2, Math.max(0.8, orbit.fov + Math.min(k, 1) * d));
            if (Math.abs(o.fovTarget - orbit.fov) < 1e-4 || (orbit.fov === 0.8 && d < 0) || (orbit.fov === 1.2 && d > 0)) orbit.fov = o.fovTarget;
          } else orbit.fov = o.fovTarget;
          cam = { eye: e, at: a, fov: orbit.fov };
          if (s >= 1 && orbit.fov === o.fovTarget) released = true;
        }
      }
      return { cam, hideShip, ui, t, done: dead || (released && t >= JUMP_T.FX_LIFE), released };
    },
    cancel() { dead = true; released = true; for (const x of timers) clearTimeout(x); },
  };
}

// ── 着色器 ──
// jumptunneltransparent.fx（Main 技术，transparentAreas = SRCALPHA / INVSRCALPHA）
// 顶点：沿管长滚动（frac(Time × GD.w) × GD.x）、两端收拢（bulge）、蛇形波（RW.x × sin(RW.z × z01 + Time × RW.y)）、绕管轴转（Time × RW.w）
const TUN_VS = `${LOG_V} uniform float T; uniform mat4 uW; uniform vec4 RW, TP, STP, GD, NC;
  varying vec4 v1; varying vec3 v2, v3, v4;
  void main() {
    float zp = position.z + GD.x * 0.25 - fract(T * GD.w) * GD.x * 0.5;
    float z01 = clamp((zp + GD.x * 0.25) / (GD.x * 0.5), 0.0, 1.0);
    float q = 2.0 * abs(z01 - 0.5); q *= q;
    float bulge = 1.0 - q * q;
    float x1 = position.x + RW.x * sin(RW.z * z01 + T * RW.y);
    float a = T * RW.w, sa = sin(a), ca = cos(a);
    vec3 p = vec3(vec2((x1 * ca + position.y * sa) * GD.z, -x1 * sa + position.y * ca) * bulge, zp);
    vec4 w = uW * vec4(p, 1.0);
    gl_Position = projectionMatrix * viewMatrix * w;
    v1 = vec4(uv * STP.xy + T * STP.zw, 2.0 * uv * TP.xy + T * TP.zw);
    v2 = vec3(uv * TP.xy, z01);
    v3 = w.xyz - (uW * vec4(0.0, 0.0, NC.z, 1.0)).xyz;   // 星云取样方向（世界空间，片元里归一化）
    v4 = p;
    #include <logdepthbuf_vertex>
  }`;
const TUN_FS = `${LOG_F} uniform float T; uniform sampler2D GlowMap, HeightMap, DiffuseMap, StreakMap; uniform samplerCube NebulaMap;
  uniform vec4 FP, EP, GD, Diffuse, NC, LP, LPr;
  varying vec4 v1; varying vec3 v2, v3, v4;
  float sstep(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
  void main() {
    #include <logdepthbuf_fragment>
    // 点光（LightPosition 跟着管子一起滚动；LightProperties：x 闪烁频率、z 亮度、w 闪烁阈值）
    float d = length(vec3(LP.xy, LP.z + GD.x * 0.25 - fract(T * GD.w) * GD.x * 0.5) - v4);
    float light = sstep((LP.w - d) / d) * LPr.z * step(LPr.w, fract(T * LPr.x));
    vec3 g = texture2D(GlowMap, v2.xy).xyz;
    vec3 glow = light * vec3((g.x + g.y) * 0.5, g.y, (g.y + g.z) * 0.5) + texture2D(StreakMap, v1.xy).rgb * EP.z;
    // 前后两道侵蚀式淡入淡出（HeightMap 做边缘噪声）
    vec2 m = max(FP.xy, EP.xy);
    float h = texture2D(HeightMap, v2.xy).x;
    float fs = clamp(sstep((v2.z - m.x) / (m.y - m.x)) * (1.0 + 2.0 * h), 0.0, 1.0);
    float e = clamp((1.0 - clamp(v2.z, 0.0, 1.0) - FP.w) / (FP.z - FP.w), 0.0, 1.0);
    float a0 = min(fs, clamp(e * (1.0 + h), 0.0, 1.0));
    float q = 2.0 * abs(v2.z - 0.5); q *= q;
    float bulge = 1.0 - q * q;
    vec3 col = bulge * Diffuse.rgb * (texture2D(DiffuseMap, v2.xy).rgb + texture2D(DiffuseMap, v1.zw).rgb * h) + glow * (a0 * bulge) * (a0 * bulge);
    // 星云：立方体贴图（夹边）；客户端方向 = 场景方向的 X 取反
    vec3 nd = normalize(v3);
    vec3 neb = textureCube(NebulaMap, vec3(-nd.x, nd.y, nd.z), -1.0).rgb;
    gl_FragColor = vec4(mix(neb, col, sstep((v2.z - NC.x) / (NC.y - NC.x))), a0 * NC.w + (1.0 - NC.w));
  }`;
// jumptunneldistortion.fx：两遍（ADD 写 +o / MAX、REVSUBTRACT 写 −o / MAX → 净 2o / MAX，z = 1/256，w = DistortionFactors.y）
//   这里合成一遍：直接写 2o（像素，后处理的扭曲缓冲约定），客户端屏幕 y 向下 → y 取反
const DIST_VS = `${LOG_V} uniform float T; uniform mat4 uW; uniform vec4 RW, GD;
  varying vec2 v2;
  void main() {
    float zp = position.z + GD.x * 0.25 - fract(T * GD.w) * GD.x * 0.5;
    float z01 = clamp((zp + GD.x * 0.25) / (GD.x * 0.5), 0.0, 1.0);
    float q = 2.0 * abs(z01 - 0.5), q2 = q * q;
    float bulge = 1.0 - q2 * q2;
    float x1 = position.x + RW.x * sin(RW.z * z01 + T * RW.y);
    float a = T * RW.w, sa = sin(a), ca = cos(a);
    vec2 r = vec2((x1 * ca + position.y * sa) * GD.z, -x1 * sa + position.y * ca) * bulge;
    gl_Position = projectionMatrix * viewMatrix * (uW * vec4(r, zp, 1.0));
    v2 = vec2((1.0 - q) * (1.0 - q), length(vec2(r.x, r.y * GD.z)));
    #include <logdepthbuf_vertex>
  }`;
const DIST_FS = `${LOG_F} uniform float T; uniform sampler2D RadialDistortionMap; uniform vec4 DF, RTP;
  varying vec2 v2;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 o = (texture2D(RadialDistortionMap, vec2(v2.y * RTP.x + T * RTP.z, T * RTP.w)).xy - 0.5) * DF.x * v2.x;
    gl_FragColor = vec4(2.0 * o.x, -2.0 * o.y, 0.00390625, DF.y);
  }`;
// specialfx/flarequad.fx（EveChildQuad）：中心放进视图空间，角点按局部矩阵左上 2×2 × 父矩阵平均缩放展开；
//   越偏离视线中心越暗（asin(cos 夹角) / (π/2) 的平方）；衰减 (1 / (min(r, 1) + 0.001) − 0.999001) × 1.001（软版 flarequadsoft 是 1/√(r + 0.1) − 0.953463）
const FQ_VS = `${LOG_V} uniform vec3 uCenter; uniform vec4 uAxes; uniform float uScale; uniform vec4 uColor; varying vec2 vUv; varying vec3 vCol;
  void main() {
    vec4 mv = viewMatrix * vec4(uCenter, 1.0);
    float k = asin(clamp(-mv.z / length(mv.xyz), 0.0, 1.0)) / 1.570796;
    vCol = uColor.rgb * k * k;
    vec2 c = position.xy;
    mv.xy += vec2(c.x * uAxes.x + c.y * uAxes.z, c.x * uAxes.y + c.y * uAxes.w) * uScale;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const FQ_FS = `${LOG_F} varying vec2 vUv; varying vec3 vCol;
  void main() {
    #include <logdepthbuf_fragment>
    float r = min(length(vUv * 2.0 - 1.0), 1.0);
    gl_FragColor = vec4(vCol * ((1.0 / (r + 0.001) - 0.999001) * 1.001), 0.0);
  }`;
// specialfx/ubershadertwosided.fx（照抄 sim-cfx.js 的 uber2：菲涅尔在顶点里算，MaskMap 夹边）；additiveAreas = ONE / ONE
const FRES = `float fres(vec3 V, vec3 N, vec4 F) {
    float x = pow(1.0 - clamp(dot(V, N) - F.z, 0.0, 1.0), F.x);
    return F.y < 0.0 ? (1.0 - min(x, 1.0)) * -F.y : x * F.y;
  }`;
const UBER2_VS = `${LOG_V} uniform vec4 TextureScroll1, TextureScroll2, TextureTransform1, TextureTransform2, FresnelFactors; uniform float time;
  varying vec2 vUv; varying vec4 vUv12; varying float vF; ${FRES}
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vUv = uv;
    vUv12 = vec4(uv * TextureTransform1.zw + TextureTransform1.xy + TextureScroll1.xy * time + TextureScroll1.zw, uv * TextureTransform2.zw + TextureTransform2.xy + TextureScroll2.xy * time + TextureScroll2.zw);
    mat3 M = mat3(modelMatrix);
    mat3 C = mat3(cross(M[1], M[2]), cross(M[2], M[0]), cross(M[0], M[1]));
    vec3 N = normalize(C * normal) * sign(dot(M[0], cross(M[1], M[2])));
    vF = fres(normalize(cameraPosition - wp.xyz), N, FresnelFactors);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const UBER2_FS = `${LOG_F} uniform sampler2D DiffuseMap1, DiffuseMap2, MaskMap; uniform vec4 DiffuseColor; varying vec2 vUv; varying vec4 vUv12; varying float vF;
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = texture2D(DiffuseMap1, vUv12.xy) * texture2D(DiffuseMap2, vUv12.zw) * texture2D(MaskMap, vUv) * vF * DiffuseColor;
  }`;

// ── 对象树：_ref → 对象、曲线组 ──
function resolve(json) {
  const root = structuredClone(json);
  const ids = new Map();
  const collect = (o) => { if (Array.isArray(o)) o.forEach(collect); else if (o && typeof o === 'object') { if (o._id != null && !ids.has(o._id)) ids.set(o._id, o); Object.values(o).forEach(collect); } };
  collect(root);
  const seen = new Set();
  const fix = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && v._ref != null) o[k] = ids.get(v._ref) || null;
      else fix(v);
    }
    if (o._type === 'Tr2CurveScalarExpression' || o._type === 'Tr2CurveVector3Expression') o._rand = Math.random();   // randconst：每条曲线一个随机常数
  };
  fix(root);
  return root;
}
const find = (o, pred, seen = new Set()) => {
  if (!o || typeof o !== 'object' || seen.has(o)) return null;
  seen.add(o);
  if (!Array.isArray(o) && pred(o)) return o;
  for (const v of Object.values(o)) { const r = find(v, pred, seen); if (r) return r; }
  return null;
};
// 绑定：目标是多个分量（value.xyz）时逐个分量拷（sim-env.js 的 applyBinding 只处理单分量 / 整体）
const COMP = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
function bind(b) {
  const [k, c] = String(b.destinationAttribute || '').split('.');
  if (!c || c.length < 2) return applyBinding(b);
  const src = b.sourceObject, dst = b.destinationObject;
  if (!src || !dst) return;
  let v = src[String(b.sourceAttribute).split('.')[0]] ?? 0;
  if (!Array.isArray(v)) v = [v, v, v, v];
  const s = b.scale ?? 1, off = b.offset || [0, 0, 0, 0];
  if (!Array.isArray(dst[k])) dst[k] = [0, 0, 0, 0];
  [...c].forEach((ch, i) => { dst[k][COMP[ch]] = (v[i] ?? 0) * s + (off[COMP[ch]] ?? 0); });
}
// TriCurveSet：Play = PlayFrom(0)，Stop 只停（数值保持最后一次的结果）；播放中每帧先按顺序更新所有曲线，再按顺序拷所有绑定
//   曲线组可能挂在子节点上（jumpout 的在 EveChildContainer 上），按树的顺序全部收集
function curveSets(root) {
  const sets = {}, seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (o._type === 'TriCurveSet') { sets[o.name] = { s: o, playing: o.playOnLoad !== false, t0: 0 }; return; }
    for (const [k, v] of Object.entries(o)) if (k === 'curveSets' || k === 'children' || k === 'objects' || k === 'effectChildren' || Array.isArray(o)) walk(v);
  };
  walk(root);
  return {
    sets,
    play(name, now) { const x = sets[name]; if (x) { x.playing = true; x.t0 = now; } },
    stop(name) { const x = sets[name]; if (x) x.playing = false; },
    start(now) { for (const x of Object.values(sets)) x.t0 = now; },
    apply(now) {
      for (const x of Object.values(sets)) {
        if (!x.playing) continue;
        const t = (now - x.t0) / 1000 * (x.s.scale ?? 1);
        for (const c of x.s.curves || []) {
          c.currentValue = curveValue(c, t);
          if (c._type === 'TriPerlinCurve') c.value = c.currentValue;   // TriPerlinCurve 把结果写回 value（绑定里有读 value 的）
        }
        for (const b of x.s.bindings || []) bind(b);
      }
    },
  };
}

// scene：three 场景；base：资源目录（assets/eveui/fx/jump/）
export function createJumpFx(scene, base) {
  let data = null, loading = null;
  const texLoader = new THREE.TextureLoader();
  const tex2d = (name, clamp) => new Promise((ok) => texLoader.load(`${base}tex/${name}.png?v=1`, (t) => {
    t.flipY = false;   // 按 DirectX 的 uv（v 向下）采样
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    ok(t);
  }, undefined, () => ok(null)));
  const meshGeo = (name) => fetch(`${base}mesh/${name}.json?v=1`).then((r) => r.json()).then((m) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.p, 3));
    if (m.n.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.n, 3));
    if (m.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
    g.setIndex(m.i);
    return g;
  });
  function load() {
    loading ||= Promise.all([
      fetch(`${base}tunnel.json?v=1`).then((r) => r.json()), fetch(`${base}jumpout.json?v=1`).then((r) => r.json()),
      meshGeo('jumptunnel3'), meshGeo('wormhole_01a_z'), meshGeo('unit_plane'),
      tex2d('jumptunneldiffuse3'), tex2d('jumptunnelglow_03a'), tex2d('jumptunnelheight_03a'), tex2d('gradientblueish_01g'), tex2d('warptunnel4_n'),
      tex2d('caustic_13'), tex2d('aurora_01_bw', true),
      new Promise((ok) => new THREE.CubeTextureLoader().setPath(`${base}tex/m10_cube/`).load(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => f + '.webp?v=1'),
        (t) => { t.colorSpace = THREE.SRGBColorSpace; ok(t); }, undefined, () => ok(null))),   // sky.py 按 sRGB 编码存，按 sRGB 解回线性
    ]).then(([tunnel, jumpout, gTun, gWorm, gPlane, diff, glow, height, streak, radial, caustic, aurora, neb]) => {
      data = { tunnel, jumpout, gTun, gWorm, gPlane, tex: { diff, glow, height, streak, radial, caustic, aurora, neb } };
      return data;
    }).catch((e) => { console.warn('sim-jump', e); loading = null; return null; });
    return loading;
  }

  const distScene = new THREE.Scene();
  const v4 = (a) => new THREE.Vector4(...(a || [0, 0, 0, 0]));
  const constOf = (fx, name) => (fx.constParameters || []).find((p) => p.name === name)?.value;

  // 一次过场里的特效实例（隧道 + 船上的 jumpout）
  function instance(d) {
    const tunRoot = resolve(d.tunnel.root), outRoot = resolve(d.jumpout.root);
    const tunSets = curveSets(tunRoot), outSets = curveSets(outRoot);
    const tunNode = find(tunRoot, (o) => o.name === 'Tunnel' && o._type === 'EveTransform');
    const trFx = tunNode.mesh.transparentAreas[0].effect, dsFx = tunNode.mesh.distortionAreas[0].effect;
    const par = (fx, name) => (fx.parameters || []).find((p) => p.name === name);
    const P = { FP: par(trFx, 'FadeParams'), NC: par(trFx, 'NebulaControls'), EP: par(trFx, 'ExtraParams'), LP: par(trFx, 'LightPosition'), LPr: par(trFx, 'LightProperties'), DF: par(dsFx, 'DistortionFactors') };
    const t = d.tex;
    const tunMat = new THREE.ShaderMaterial({
      uniforms: {
        T: { value: 0 }, uW: { value: new THREE.Matrix4() },
        RW: { value: v4(constOf(trFx, 'RotationAndWaveParams')) }, TP: { value: v4(constOf(trFx, 'TextureParams')) }, STP: { value: v4(constOf(trFx, 'StreakTextureParams')) },
        GD: { value: v4(constOf(trFx, 'GeometryDescription')) }, Diffuse: { value: v4(constOf(trFx, 'Diffuse')) },
        NC: { value: v4() }, FP: { value: v4() }, EP: { value: v4() }, LP: { value: v4() }, LPr: { value: v4() },
        GlowMap: { value: t.glow }, HeightMap: { value: t.height }, DiffuseMap: { value: t.diff }, StreakMap: { value: t.streak }, NebulaMap: { value: t.neb },
      },
      vertexShader: TUN_VS, fragmentShader: TUN_FS,
      // scene.warpTunnel 槽：背景层（星空之后、所有物体之前），不测深度；Stop（5 秒）之后挪进 scene.objects，改成普通半透明物体
      transparent: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const tun = new THREE.Mesh(d.gTun, tunMat);
    tun.frustumCulled = false; tun.renderOrder = -9; tun.visible = false;
    scene.add(tun);
    const distMat = new THREE.ShaderMaterial({
      uniforms: {
        T: { value: 0 }, uW: tunMat.uniforms.uW, RW: { value: v4(constOf(dsFx, 'RotationAndWaveParams')) }, GD: { value: v4(constOf(dsFx, 'GeometryDescription')) },
        DF: { value: v4() }, RTP: { value: v4(constOf(dsFx, 'RadialTextureParams')) }, RadialDistortionMap: { value: t.radial },
      },
      vertexShader: DIST_VS, fragmentShader: DIST_FS,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const dist = new THREE.Mesh(d.gTun, distMat);
    dist.frustumCulled = false; dist.visible = false;
    distScene.add(dist);

    // jumpout_tr_t1a：EveEffectRoot2 → 容器 → Roter（缩放 3,3,4）→ QuadFlare + HideOnLQ（displayFilter 3：shader 档位 ≥ HI 才画）→ 涡旋网格（Billboard3D）
    const quad = find(outRoot, (o) => o.name === 'QuadFlare');
    const roter = find(outRoot, (o) => o.name === 'Roter');
    const worm = find(outRoot, (o) => o.name === 'Tunnel2_HideOnLQBillboard');
    const wFx = worm.mesh.additiveAreas[0].effect;
    const fqMat = new THREE.ShaderMaterial({
      uniforms: { uCenter: { value: new THREE.Vector3() }, uAxes: { value: new THREE.Vector4() }, uScale: { value: 1 }, uColor: { value: new THREE.Vector4() } },
      vertexShader: FQ_VS, fragmentShader: FQ_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const fq = new THREE.Mesh(d.gPlane, fqMat);
    fq.frustumCulled = false; fq.visible = false;
    scene.add(fq);
    const wU = {
      time: { value: 0 }, FresnelFactors: { value: v4() }, TextureTransform1: { value: v4() }, TextureTransform2: { value: v4() },
      DiffuseColor: { value: v4(constOf(wFx, 'DiffuseColor')) }, TextureScroll1: { value: v4(constOf(wFx, 'TextureScroll1')) }, TextureScroll2: { value: v4(constOf(wFx, 'TextureScroll2')) },
      DiffuseMap1: { value: t.caustic }, DiffuseMap2: { value: t.caustic }, MaskMap: { value: t.aurora },
    };
    const wMat = new THREE.ShaderMaterial({
      uniforms: wU, vertexShader: UBER2_VS, fragmentShader: UBER2_FS, side: THREE.FrontSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const wm = new THREE.Mesh(d.gWorm, wMat);
    wm.frustumCulled = false; wm.matrixAutoUpdate = false; wm.visible = false;
    scene.add(wm);
    const wP = (n) => (wFx.parameters || []).find((p) => p.name === n);
    return {
      tunSets, outSets, P, tunRoot, tunNode, tun, tunMat, dist, distMat, quad, roter, worm, fq, fqMat, wm, wU, wFF: wP('FresnelFactors'), wTT1: wP('TextureTransform1'), wTT2: wP('TextureTransform2'),
      dispose() {
        scene.remove(tun, fq, wm); distScene.remove(dist);
        for (const m of [tunMat, distMat, fqMat, wMat]) m.dispose();
      },
    };
  }

  // 每帧的矩阵（客户端坐标、千米）
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mC = new THREE.Matrix4(), qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3();
  const camC = new THREE.Vector3(), rightC = new THREE.Vector3(), upC = new THREE.Vector3(), fwdC = new THREE.Vector3();
  const mirrorV = (v) => v.set(-v.x, v.y, v.z);
  // EveChildModifierBillboard3D（fixed = false）：Billboard2D（3×3 换成逆视图矩阵的三个轴 × 原轴长）→ DistanceBase 对齐矩阵，out = billboard · align（align 先作用）
  const bbA = new THREE.Matrix4(), cf = new THREE.Vector3(), rt = new THREE.Vector3(), up = new THREE.Vector3(), rr = new THREE.Vector3();
  const intoBasis = (out, v, e) => out.set(v.x * e[0] + v.y * e[1] + v.z * e[2], v.x * e[4] + v.y * e[5] + v.z * e[6], v.x * e[8] + v.y * e[9] + v.z * e[10]);
  function billboard3D(T, out) {
    const e = T.elements, o = out.copy(T).elements;
    const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
    o[0] = rightC.x * sx; o[1] = rightC.y * sx; o[2] = rightC.z * sx;
    o[4] = upC.x * sy; o[5] = upC.y * sy; o[6] = upC.z * sy;
    o[8] = fwdC.x * sz; o[9] = fwdC.y * sz; o[10] = fwdC.z * sz;
    intoBasis(cf, vA.set(camC.x - o[12], camC.y - o[13], camC.z - o[14]), o);
    const lx = o[0] ** 2 + o[1] ** 2 + o[2] ** 2, ly = o[4] ** 2 + o[5] ** 2 + o[6] ** 2, lz = o[8] ** 2 + o[9] ** 2 + o[10] ** 2;
    cf.set(lx ? cf.x / lx : 0, ly ? cf.y / ly : 0, lz ? cf.z / lz : 0).normalize();
    intoBasis(rt, rightC, o);   // 视图矩阵第一列（_11, _21, _31）= 镜头右方向
    up.crossVectors(cf, rt).normalize();
    rr.crossVectors(up, cf);
    bbA.set(rr.x, up.x, cf.x, 0, rr.y, up.y, cf.y, 0, rr.z, up.z, cf.z, 0, 0, 0, 0, 1);
    return out.multiply(bbA);
  }

  // 开始一次过场：o = { gateYaw（场景里导管绕 Y 的转角）, shipR（船的包围半径，千米）}；返回实例控制器（异步加载好才出画面）
  function run(o) {
    let inst = null, dead = false, t0 = null;
    const st = { bgSlot: true };   // 已经切过的时间点
    load().then((d) => { if (d && !dead) inst = instance(d); });
    // 导管旋转（客户端）：场景里绕 Y 转 yaw → 客户端 (0, sin(−yaw/2), 0, cos(yaw/2))
    const gateQ = new THREE.Quaternion(0, Math.sin(-o.gateYaw / 2), 0, Math.cos(o.gateYaw / 2));
    return {
      // t：过场时间（毫秒，JUMP_T 的 0 点 = createJumpSequence 开始）；camera：已经摆好的镜头；ship：{ pos（场景）, quat（场景）} 或 null；hi：高画质
      update(t, camera, ship, hi) {
        if (!inst) return;
        if (t0 == null) { t0 = performance.now() - t; inst.tunSets.start(t0); inst.outSets.start(t0); }
        const now = t0 + t, T = t / 1000;
        const S = inst.tunSets;
        // 曲线组时间线（Jump.py）：init 850 播、3200 停；start 3200 播；main 3700 播；lighting 加载即播；stop 在隧道拿掉之后才播（看不到）
        if (t >= JUMP_T.INIT && !st.init) { st.init = 1; S.play('init', now - (t - JUMP_T.INIT)); }
        if (t >= JUMP_T.TUNNEL && !st.start) { st.start = 1; S.stop('init'); S.play('start', now - (t - JUMP_T.TUNNEL)); }
        if (t >= JUMP_T.MID && !st.main) { st.main = 1; S.play('main', now - (t - JUMP_T.MID)); }
        const showTun = t < JUMP_T.END;
        inst.tun.visible = showTun; inst.dist.visible = showTun && hi;
        if (showTun) {
          S.apply(now);
          // 隧道矩阵：EveRootTransform.rotation = 导管 rotation；JumpTransition（旋转 [0,1,0,~0]、缩放 1000,1000,3000 米）
          //   modifier 2 = TRANSLATE_WITH_CAMERA（世界平移 = 镜头位置）；子节点 Tunnel 的 translation 由 lighting 组的 tunnelShake × 1.5 驱动
          const jt = inst.tunRoot;
          qA.copy(gateQ).multiply(qB.fromArray(jt.rotation || [0, 0, 0, 1]));
          mA.compose(vA.set(0, 0, 0), qA, vB.fromArray(jt.scaling || [1, 1, 1]).multiplyScalar(KM));
          // 场景矩阵 = 镜像 · 客户端矩阵；根节点的世界平移 = 镜头位置（场景里），再乘子节点 Tunnel 的局部平移
          const W = inst.tunMat.uniforms.uW.value.multiplyMatrices(MIRROR, mA);
          W.elements[12] = camera.position.x; W.elements[13] = camera.position.y; W.elements[14] = camera.position.z;
          const tr = inst.tunNode.translation || [0, 0, 0];
          W.multiply(mB.makeTranslation(tr[0], tr[1], tr[2]));
          const U = inst.tunMat.uniforms, P = inst.P;
          U.T.value = T; U.FP.value.fromArray(P.FP.value); U.NC.value.fromArray(P.NC.value); U.EP.value.fromArray(P.EP.value);
          U.LP.value.fromArray(P.LP.value); U.LPr.value.fromArray(P.LPr.value);
          inst.distMat.uniforms.T.value = T; inst.distMat.uniforms.DF.value.fromArray(P.DF.value);
          // Stop（5 秒）：从 scene.warpTunnel 挪进 scene.objects → 普通半透明物体（测深度、在物体之后画）
          if (t >= JUMP_T.SHOW && st.bgSlot) { st.bgSlot = false; inst.tunMat.depthTest = true; inst.tunMat.transparent = true; inst.tun.renderOrder = 0; }
        }
        // jumpout：挂在船上（transformFlags 1/3/4：船球位置、船球朝向、缩放 = 模型包围球半径）
        const showFx = t < JUMP_T.FX_LIFE && ship;
        inst.fq.visible = Boolean(showFx);
        inst.wm.visible = Boolean(showFx && hi);   // HideOnLQ：displayFilter 3（SHADER_HIGHMID）
        if (showFx) {
          inst.outSets.apply(now);
          // 镜头（客户端坐标）：位置、右 / 上 / 前三个轴（场景镜头的轴沿 X 镜像；three 的镜头看 −Z）
          camera.updateMatrixWorld();
          const ce = camera.matrixWorld.elements;
          mirrorV(camC.copy(camera.position));
          mirrorV(rightC.set(ce[0], ce[1], ce[2]).normalize());
          mirrorV(upC.set(ce[4], ce[5], ce[6]).normalize());
          mirrorV(fwdC.set(-ce[8], -ce[9], -ce[10]).normalize());
          // 船：客户端旋转 = 镜像 · 场景旋转 · 镜像
          mC.makeRotationFromQuaternion(ship.quat);
          mC.premultiply(MIRROR).multiply(MIRROR);
          mA.makeTranslation(-ship.pos.x, ship.pos.y, ship.pos.z).multiply(mC).multiply(mB.makeScale(o.shipR, o.shipR, o.shipR));
          const rs = inst.roter.scaling || [1, 1, 1];
          mA.multiply(mB.makeScale(rs[0], rs[1], rs[2]));   // Roter 的世界矩阵（外层容器、HideOnLQ 都是单位矩阵）
          // QuadFlare：中心 = 父矩阵 × 自己的平移（0）；角点按局部矩阵左上 2×2 × 父矩阵三轴之和的长度 / √3
          const q = inst.quad, fu = inst.fqMat.uniforms, pe = mA.elements, qs = q.scaling || [1, 1, 1];
          fu.uCenter.value.set(-pe[12], pe[13], pe[14]);
          fu.uAxes.value.set(qs[0], 0, 0, qs[1]);
          fu.uScale.value = Math.hypot(pe[0] + pe[4] + pe[8], pe[1] + pe[5] + pe[9], pe[2] + pe[6] + pe[10]) * 0.57735;
          const c = q.color || [1, 1, 1, 1], b = q.brightness ?? 1;
          fu.uColor.value.set(c[0] * b, c[1] * b, c[2] * b, 1);
          // 涡旋网格：局部缩放 15.53 → Billboard3D → 场景
          const ws = inst.worm.scaling || [1, 1, 1];
          billboard3D(mB.copy(mA).multiply(mC.makeScale(ws[0], ws[1], ws[2])), inst.wm.matrix);
          inst.wm.matrix.premultiply(MIRROR);
          inst.wm.matrixWorld.copy(inst.wm.matrix);
          const u = inst.wU;
          u.time.value = T;
          u.FresnelFactors.value.fromArray(inst.wFF.value); u.TextureTransform1.value.fromArray(inst.wTT1.value); u.TextureTransform2.value.fromArray(inst.wTT2.value);
        }
      },
      dispose() { dead = true; inst?.dispose(); inst = null; },
    };
  }
  return { distScene, load, run, dispose() { distScene.clear(); } };
}
