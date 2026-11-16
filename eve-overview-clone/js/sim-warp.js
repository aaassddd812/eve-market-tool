// ===== 跃迁隧道（只给自己的船画）=====
// 照客户端 res:/model/effect3/warptunnel.black（effects.Warping，graphicID 21048）和三个着色器的反汇编重写：
//   网格 Sphere4k.gr2（半径 0.01 的球），EveTransform 缩放 (16000, 150000, 10000)、绕 X 转 90° → 以镜头为中心、
//   沿跃迁方向拉长的椭球（宽 160 m、长 1500 m、高 100 m）；客户端挂在 scene.warpTunnel 槽里，不随船平移。
//   朝向（Warp.py AlignToDirection）：模型 z 轴 = normalize(船 − 目的地)，x = (0,1,0) × z，y = z × x。
//   三层：warptunneltransparent（半透明隧道壁：侵蚀式淡入淡出、速度条纹、前蓝后红的多普勒色、反射星空）
//         warptunneladditive（加色：两层流动的漫反射 + 闪电）
//         warptunneldistortion（屏幕扭曲：把偏移写进扭曲缓冲，后处理按它挪动画面；只在高画质的后处理里有）
//           着色器输出 = 偏移 ÷ MAX_DISTORTION_OFFSET，后处理再乘回去——这个全局常量没拿到，这里直接按像素偏移用（推断）；
//           两个变体一正一负（正面 / 背面），镜头在椭球里面，看到的是背面
//   参数取 .black 里的值（不穿越行星时就是存盘值）；速度 → 强度用 .black 的「Speed To Intensity Curve」，
//   速度先乘 1 / (3 AU × 跃迁速度倍率)（Warp.py SetupTunnelBindings）。
//   FadeIn / FadeOut 两个控制量 .black 和 Python 里都没有来源（引擎内部驱动）：这里按推断——
//   进入跃迁后 1.5 秒内 0 → 1 淡入，开始减速后 1.5 秒内 0 → 1 淡出。
import * as THREE from './vendor/three/three.module.min.js';

// .black 里的 Hermite 关键帧：[时间, 值, 切线]
const SPEED_KEYS = [[0, 0, 99.998703], [5e-6, 0.3, 6.888689], [0.019024, 0.689492, 2.232882], [0.180367, 0.881352, 0.52198], [1, 1, -0.004455]];
export function speedIntensity(s) {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  let i = 0;
  while (i < SPEED_KEYS.length - 2 && s > SPEED_KEYS[i + 1][0]) i++;
  const [t0, v0, m0] = SPEED_KEYS[i], [t1, v1, m1] = SPEED_KEYS[i + 1], d = t1 - t0, u = (s - t0) / d;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 * d + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1 * d;
}

// 共用的顶点变形（三个着色器的 VS 都一样）：沿长度的蛇形波 + 绕长轴自转；模型 Y 是长轴
const WARP_VS = `
  uniform float T; uniform vec4 misc;   // misc = (WaveScale, Speed, WaveLength, RotationSpeed)
  vec3 warpPos(vec3 p, vec2 uv) {
    float z = p.z + misc.x * sin(misc.z * uv.y + T * misc.y);
    float a = T * misc.w, s = sin(a), c = cos(a);
    return vec3(p.x * c + z * s, p.y, -p.x * s + z * c);
  }`;

const TRANS_VS = `${WARP_VS}
  uniform vec4 tunTP, texTP, mf2;   // TunnelTextureParams、TextureParams、MiscFactors2 = (FadeOut, Streaks, FadeIn, SpeedInfluence)
  varying vec4 v1, v2; varying vec3 v3, v4;
  void main() {
    vec2 uv = vec2(uv.x, 1.0 - uv.y);   // three 的球 uv.y 从下到上，客户端网格 v 从上（+Y）到下
    vec4 w = modelMatrix * vec4(warpPos(position, uv), 1.0);
    gl_Position = projectionMatrix * viewMatrix * w;
    v1 = vec4(uv, uv * texTP.xy + T * texTP.zw);
    v2 = vec4(uv * tunTP.xy + T * tunTP.zw, 3.0 * clamp(mf2.y, 0.0, 1.0) * clamp(4.0 * mf2.w, 0.0, 1.0), 0.0);
    v3 = normalize(w.xyz - cameraPosition);
    v4 = normalize(-vec3(modelMatrix[1].xyz)) * 0.25;
  }`;
const TRANS_FS = `
  uniform sampler2D maskMap, capTex, tunnelMap; uniform samplerCube refl; uniform float hasRefl;
  uniform vec4 diffuse, redShift, blueShift, mf2;
  varying vec4 v1, v2; varying vec3 v3, v4;
  void main() {
    float v = v1.y, fi = clamp(mf2.z, 0.0, 1.0), fo = clamp(mf2.x, 0.0, 1.0);
    // 淡入前沿：沿 1 − v² 推进
    float hi = min(fi * 3.0, 1.0), e = 1.0 - v * v;
    float q = clamp(1.0 - (e - fi) / max(hi - fi, 1e-5), 0.0, 1.0); q *= q;
    float fHi = step(e, hi), fFi = step(e, fi);
    float inM = fFi * (1.0 - q * fHi) + fHi * q;
    float m = texture2D(maskMap, v1.zw).a;
    float m8 = clamp(m * 8.0, 0.0, 1.0), m35 = clamp(m * 3.5, 0.0, 1.0);
    inM = inM * m8 + inM; inM *= inM;
    // 淡出前沿：沿 v 推进
    float g = 1.0 - fo, hi2 = min(g * 3.0, 1.0);
    float q2 = clamp(1.0 - (v - g) / max(hi2 - g, 1e-5), 0.0, 1.0); q2 *= q2;
    float fHi2 = step(v, hi2), fG = step(v, g);
    float o = 1.0 - (fG * (1.0 - q2 * fHi2) + fHi2 * q2);
    o = o * m8 + o; o *= o;
    float a0 = fi * min(inM, 1.0) - min(o, 1.0);
    float edge = (1.0 - a0) * m35 * mf2.w;
    vec3 rd = v4 * m + v3;
    float cap = texture2D(capTex, v1.xy).r;
    float streak = clamp(cap * m * v2.z, 0.0, 1.0);
    float alpha = clamp(edge * cap + max(streak, a0), 0.0, 1.0);
    float rk = alpha > 0.0 ? cap * edge / alpha : 0.0;
    vec3 col = hasRefl > 0.5 ? textureCube(refl, rd).rgb * rk : vec3(0.0);   // 按世界方向直接取（场景坐标 = 客户端坐标）
    col += texture2D(tunnelMap, v2.xy).rgb * diffuse.rgb * cap;
    vec4 sh = mix(redShift, blueShift, step(0.5, v)) * mf2.w;
    float ic = 1.0 - cap;
    alpha = clamp(sh.a * ic + alpha, 0.0, 1.0);
    sh *= ic;
    gl_FragColor = vec4(sh.rgb * (alpha > 0.0 ? sh.a / alpha : 0.0) + col, alpha);
  }`;

const ADD_VS = `${WARP_VS}
  uniform float Tw; uniform vec4 mf2, mf3, texTP, lmp, lmmp;   // MiscFactors2 = (Brightness, MotionBlurBlend, LightingMaskStrength, SpeedInfluence)
  varying vec4 v1, v2, v4; varying vec4 v3;
  void main() {
    vec2 uv = vec2(uv.x, 1.0 - uv.y);
    vec4 w = modelMatrix * vec4(warpPos(position, uv), 1.0);
    gl_Position = projectionMatrix * viewMatrix * w;
    vec4 sc = vec4(T, T, Tw, Tw) * texTP.zwzw;
    v1.xy = uv * texTP.xy + sc.xy;
    v4.xy = uv * texTP.xy + sc.zw;
    vec2 u2 = uv + vec2(0.4, 0.92);
    v1.zw = u2 * texTP.xy + sc.xy * 0.7;
    v4.zw = u2 * texTP.xy + sc.zw * 0.7;
    v2.xy = vec2(uv.x * lmp.x + sin(T * lmp.z), uv.y * mf2.y * lmp.y + T * lmp.w);
    v2.zw = vec2(uv.x * lmmp.x, uv.y * mf2.y * lmmp.y) + T * lmmp.zw;
    vec2 f = clamp(mf3.xy, 0.0, 1.0);
    v3.z = clamp(max(f.x - f.y, 0.0) * 2.0 + mf2.w, 0.0, 1.0) * mf2.x;
    float s = sin(2.0 * T + uv.y * 0.5);
    float pulse = max(sin(T * 6.283185), 0.7);
    v3.x = (s * s * 0.6 + 0.4) * pulse * mf2.z;
    v3.y = uv.y; v3.w = pulse;
  }`;
const ADD_FS = `
  uniform sampler2D lightMap, maskMap, diffMap, capTex;
  uniform vec4 mf2, mf3, diffuseColor, lightColor;
  varying vec4 v1, v2, v4; varying vec4 v3;
  void main() {
    float m = pow(abs(texture2D(maskMap, v2.zw).r), 2.5) * v3.x;
    vec3 L = texture2D(lightMap, v2.xy).r * lightColor.rgb * m;
    vec4 d4 = texture2D(diffMap, v4.xy), d1 = texture2D(diffMap, v1.zw), d0 = texture2D(diffMap, v1.xy);
    vec2 B = mix(vec2(d1.r, d1.a), vec2(d4.r, d4.a), mf2.y);
    vec2 A = mix(vec2(d0.r, d0.a), vec2(d4.r, d4.a), mf2.y);
    vec3 c = (L * A.y * 0.25 + L * B.y) * 0.25;
    c = diffuseColor.rgb * mix(A.x, B.x, 0.35) + c;
    c *= v3.z;
    float cap = texture2D(capTex, vec2(0.5, v3.y)).r;
    gl_FragColor = vec4(c * cap + mf3.z, 1.0);
  }`;

const DIST_VS = `
  uniform float T, Tw; uniform vec4 misc, mf2, texTP;   // MiscFactors2 = (Distortion Amount, Stretch, MidStrength, SpeedInfluence)
  varying vec4 v1; varying vec2 v2;
  void main() {
    vec2 uv = vec2(uv.x, 1.0 - uv.y);
    float a = T * misc.w, s = sin(a), c = cos(a);
    vec3 p = vec3(position.x * c + position.z * s, position.y, -position.x * s + position.z * c);
    vec2 n = vec2(normal.x * c + normal.z * s, -normal.x * s + normal.z * c);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
    v1 = uv.xyxy * texTP.xyxy + vec4(T, T, Tw, Tw) * texTP.zwzw;
    vec2 o = -n * mf2.x * clamp(mf2.w, 0.0, 1.0);
    v2 = vec2(o.x, o.y * -normal.y);
  }`;
const DIST_FS = `
  uniform sampler2D noiseMap; uniform vec4 mf2;
  varying vec4 v1; varying vec2 v2;
  void main() {
    float a = texture2D(noiseMap, v1.xy).a, b = texture2D(noiseMap, v1.zw).a;
    vec2 o = mix(a, b, mf2.y) * v2 * (gl_FrontFacing ? 1.0 : -1.0);
    gl_FragColor = vec4(o.x, -o.y, 0.0, 0.0);   // 客户端屏幕 y 向下
  }`;

// base：贴图目录（assets/eveui/fx/warp/）
export function createWarpTunnel(scene, base) {
  const load = (n) => {
    const t = new THREE.TextureLoader().load(`${base}${n}.png?v=1`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;   // 按 DirectX 的 uv（v 向下）采样
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  const tex = { mask: load('lightningwarp_d'), tunMask: load('lightningwarp_tunnel_d'), cap: load('sphere_capmask'), clouds: load('clouds'), light: load('lightning01_g_hi') };
  tex.cap.wrapS = tex.cap.wrapT = THREE.ClampToEdgeWrapping;
  const geo = new THREE.SphereGeometry(0.01, 64, 40);
  const v4 = (a) => new THREE.Vector4(...a);
  const misc = v4([0.001, 1, 20, 0.8]);
  const transMat = new THREE.ShaderMaterial({
    uniforms: {
      T: { value: 0 }, misc: { value: misc }, tunTP: { value: v4([1, 4, 0, 1.5]) }, texTP: { value: v4([3, 3, 0.2, 1]) }, mf2: { value: v4([0, 0.38, 0, 0]) },
      maskMap: { value: tex.mask }, capTex: { value: tex.cap }, tunnelMap: { value: tex.clouds }, refl: { value: null }, hasRefl: { value: 0 },
      diffuse: { value: v4([0.130726, 0.158951, 0.181234, 0.095073]) }, redShift: { value: v4([0.6, 0.276, 0.1764, 0.132]) }, blueShift: { value: v4([0.198, 0.426, 0.6, 0.18]) },
    },
    vertexShader: TRANS_VS, fragmentShader: TRANS_FS,
    // 当背景层画（客户端 scene.warpTunnel 槽）：不透明队列里排在船前面、不测深度；混合照 Alpha 混合
    transparent: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const addMat = new THREE.ShaderMaterial({
    uniforms: {
      T: { value: 0 }, Tw: { value: 0 }, misc: { value: misc }, mf2: { value: v4([0.6, 0.3, 2000, 0]) }, mf3: { value: v4([0, 0, 0, 0]) },
      texTP: { value: v4([3, 2, 0.2, 1.5]) }, lmp: { value: v4([1, 1, 0.1, 0.4]) }, lmmp: { value: v4([2, 6, 0.25, 0.4]) },
      lightMap: { value: tex.light }, maskMap: { value: tex.tunMask }, diffMap: { value: tex.mask }, capTex: { value: tex.cap },
      diffuseColor: { value: v4([0.564706, 0.745098, 0.835294, 1]) }, lightColor: { value: v4([0.729412, 0.870588, 1, 1]) },
    },
    vertexShader: ADD_VS, fragmentShader: ADD_FS,
    transparent: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const group = new THREE.Group();
  const trans = new THREE.Mesh(geo, transMat), add = new THREE.Mesh(geo, addMat);
  for (const [o, k] of [[trans, -9], [add, -8]]) { o.frustumCulled = false; o.renderOrder = k; group.add(o); }
  // 模型变换：先按 EveTransform（缩放、绕 X 转 90°，单位米 → 千米），再按跃迁方向的朝向
  const inner = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(0.706684, 0, 0, 0.70753).normalize(), new THREE.Vector3(16, 150, 10));
  const orient = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  group.matrixAutoUpdate = false;
  group.visible = false;
  scene.add(group);
  // 扭曲层：单独的场景，后处理画进扭曲缓冲
  const distMat = new THREE.ShaderMaterial({
    uniforms: { T: { value: 0 }, Tw: { value: 0 }, misc: { value: misc }, mf2: { value: v4([144, 0.6, 80, 0]) }, texTP: { value: v4([3, 3, 0.2, 1]) }, noiseMap: { value: tex.mask } },
    vertexShader: DIST_VS, fragmentShader: DIST_FS,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const distScene = new THREE.Scene(), dist = new THREE.Mesh(geo, distMat);
  dist.frustumCulled = false; dist.matrixAutoUpdate = false; dist.visible = false;
  distScene.add(dist);
  const t0 = performance.now() / 1000;
  return {
    distScene,
    setEnv(cube) { transMat.uniforms.refl.value = cube; transMat.uniforms.hasRefl.value = cube ? 1 : 0; },
    // st = null 不画；{ dir: 跃迁方向（单位向量）, sf: 速度 / (3 AU × 跃迁速度倍率), fi, fo: 淡入 / 淡出 0–1 }
    update(camera, st) {
      group.visible = dist.visible = Boolean(st);
      if (!st) return;
      Z.set(-st.dir[0], -st.dir[1], -st.dir[2]).normalize();   // z = 船 − 目的地
      X.crossVectors(UP, Z);
      if (X.lengthSq() < 1e-12) X.set(1, 0, 0);
      X.normalize();
      Y.crossVectors(Z, X);
      orient.makeBasis(X, Y, Z).setPosition(camera.position);
      group.matrix.multiplyMatrices(orient, inner);
      group.matrixWorldNeedsUpdate = true;
      dist.matrix.copy(group.matrix); dist.matrixWorld.copy(group.matrix);
      const T = performance.now() / 1000 - t0, si = speedIntensity(st.sf);
      transMat.uniforms.T.value = addMat.uniforms.T.value = T;
      addMat.uniforms.Tw.value = T - 1 / 30;   // 【推断】Time.w：上一帧的时间（运动模糊用）
      transMat.uniforms.mf2.value.set(st.fo, 0.38, st.fi, si);
      addMat.uniforms.mf2.value.w = si;
      addMat.uniforms.mf3.value.set(st.fi, st.fo, 0, 0);
      distMat.uniforms.T.value = T; distMat.uniforms.Tw.value = T - 1 / 30;
      distMat.uniforms.mf2.value.w = si * 8;   // .black 的 distortionBinding：scale 8
    },
  };
}

// 镜头抖动强度（Warp.py ShakeCamera）：speed、maxV 米 / 秒，warpAU 跃迁速度（AU / 秒）
export function warpShake(speed, maxV, warpAU) {
  const s = Math.max(0, (speed - maxV) / (warpAU * 149597870700 - maxV));
  const r = Math.max(0, (0.5 - 0.5 * Math.cos(6.28 * s ** 0.1) - 0.2) / 0.8) ** 0.8;
  return 0.7 * r;
}
