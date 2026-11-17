// ===== 战场模拟的 3D 视图（three.js）=====
// 读取 sim-engine.js 的记录（每 0.5 秒一帧：位置、三层血量、目标、这一步的开火 / 遥修、无人机位置），按时间插值画出：
//   像游戏里一样，每艘船都有总览图标（按舰船类别，A 方蓝、B 方红，残骸灰色），始终显示在屏幕上；
//   舰船本身用游戏内模型（sim-ships.js），按真实大小摆放，所以拉远时很小、拉近才看得清；没有模型文件时只显示图标。
//   开火、导弹、命中、阵亡爆炸由 sim-fx.js 按武器种类画；出击的无人机 / 舰载机中队也有总览图标；
//   悬停、选中、点名集火的船，图标外套一圈细线（像游戏里一样贴着图标）；开启诱导、诱导进场的位置有一团闪光；
//   跃迁撤离的船消失（不留残骸）。坐标单位：千米。模型逐个加载，hooks.onProgress(已加载, 总数) 报告进度。
//   像联盟锦标赛（AT）直播一样：星云天空、名字下面三层血条；「导播镜头」自动环绕战场。
// 画质（opt.quality）：high 高画质；low 不画星云、按 1 倍像素渲染；auto 先按高画质画，持续低于 24 帧就降到低画质（hooks.onQuality）。
// 驾驶模拟用：opt.fx = 游戏特效贴图目录（sim-fx.js）；loadState() 报告模型 / 星空 / 特效贴图是否都加载好了（开局前等它）；
// setTactical({ center, opt, fall, lock }) 打开战术视图（游戏的 Ctrl + D）：以 center 那艘船为中心的水平网格盘（距离圈、方位线），
//   武器最佳射程（淡色实心）、失准范围（渐隐）、锁定距离（虚线圈），每艘船一条竖线连到网格平面（单位千米；null 关闭）。
// 观察者视角：拖动旋转、滚轮 / 双指缩放、右键 / 双指拖动平移；悬停显示舰船，点击选中，双击镜头跟随（手动转动镜头会退出导播，hooks.onDirector）。
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { loadShipIndex, loadShipModel, bracketAtlas, BRACKETS, DRONE_BRACKETS, SHIP_TIME } from './sim-ships.js?v=v20';
import { createFx } from './sim-fx.js?v=v37';
import { createCelestials, sunLight } from './sim-cel.js?v=16';
import { createWarpTunnel } from './sim-warp.js?v=5';
import { createFlare } from './sim-flare.js?v=3';
import { createEnvFx } from './sim-env.js?v=5';
import { createSSAO, SSAO_LAYER, SHIP_AO } from './sim-ssao.js?v=1';
import { updateShipLights, clearShipLights, SHIP_LIGHTS } from './sim-lights.js?v=7';
import { createReflection } from './sim-reflect.js?v=1';
import { createJumpFx, createJumpSequence, createShaker, shakeBehavior, linearCurve } from './sim-jump.js?v=3';
import { createStarfield, starCount } from './sim-stars.js?v=2';
import { createDustfield } from './sim-dust.js?v=2';
import { createSecondaryLighting, shIntensity } from './sim-shl.js?v=2';

const WRECK = new THREE.Color(0x8a9099);
const WHITE = new THREE.Color(1, 1, 1), OWN_COL = new THREE.Color(0.7, 0.7, 0.7);
const KM = 1 / 1000;
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // 画在画布上的文字不走自动翻译
const ICON_PX = 18;        // 总览图标大小（CSS 像素）
const RING_PX = 9.5;       // 选中圈半径（CSS 像素，刚好套住图标）
const WRECK_ICON = BRACKETS.indexOf('wreck');
const BR_COLS = 16;        // 游戏图标图集：16×16 格
const WRECK_PATH = 'shared/brackets/wreck.png';   // 残骸（客户端 wreck 组的图标）
const CEL_BRK = { 6: 'shared/brackets/sun.png', 7: 'shared/brackets/planet.png', 8: 'shared/brackets/moon.png', 9: 'shared/brackets/asteroidbelt.png', 10: 'shared/brackets/stargate.png', 15: 'shared/brackets/station.png' };

// ── 后处理（照客户端 Tr2PostProcessRenderer 的流程和 postprocess/downsample、upsample、tonemapping 着色器）──
// 场景画进半浮点缓冲，里面存 sRGB 编码值（和客户端一样：船体 quadv5、尾焰等着色器结尾自己做线性 → sRGB）。
// 泛光（实机 RenderDoc 抓帧，五帧一致）：半分辨率 postprocess/highpassfilter —— 取 2×2 个双线性采样里亮度最低的一个（防闪点），
//       亮度 < 阈值 0.66（sRGB 编码值上算）就是 0，否则 线性色 × (1 − 阈值 ÷ 亮度) × 0.333；
//       再 postprocess/blur 横、纵各一遍（20 次双线性采样 ≈ 39 点高斯，偏移以半分辨率像素计）。
// 合成：场景解码成线性；泛光 × 0.2 后过 Uncharted2 曲线加上去；乘曝光；再过 Uncharted2：U(2c) ÷ U(W)；sRGB 编码；加抖动。
//       曲线参数、曝光中值、泛光强度和抓帧里 tonemapping 的常量缓冲一致。
// 之后（抓帧顺序）：postprocess/cas 锐化（十字 5 点、按绿色通道定强度，锐度 0.5 → peak = −1/6.5）→ postprocess/filmgrain 胶片颗粒。
// 动态曝光（Tr2PostProcessRenderer::RenderDynamicExposure，照 ccpwgl2 的 WebGL 实现）：
//   每个像素 sRGB 解码、Rec.709 亮度，按 ln(亮度) 在 ln(minLuminance)~ln(maxLuminance) 间分 64 桶 →
//   取像素数 0.9 / 0.98 分位上的亮度（桶内插值），平均 = 两者中点；scale = clamp(0.5 ÷ 平均, 2^minExposure, 2^maxExposure)，目标 = 0.5 ÷ scale；
//   在平方根空间按 1 − e^(−速度 × dt) 追目标（变亮 increaseSpeed，变暗 decreaseSpeed）；
//   合成时曝光 = middleValue ÷ mix(0.5, 适应值, influence)（tonemapping 动态曝光分支的反汇编）。
//   需要浮点混合（EXT_float_blend）；没有时曝光固定为 1。
const BLOOM = { threshold: 0.66, scale: 0.333, brightness: 0.2 };   // 抓帧：highpassfilter cb0[0].xy、tonemapping cb0[0].w
// blur 着色器里的权重 / 偏移表（立即数常量缓冲）
const BLUR_TAPS = [[0.000614, -18.178738], [0.003546, -16.346853], [0.009435, -14.401047], [0.018573, -12.427081], [0.031174, -10.442309], [0.047406, -8.45229], [0.067412, -6.459331], [0.091315, -4.464563], [0.119225, -2.468604], [0.151241, -0.471819],
  [0.134714, 1.470298], [0.104763, 3.466706], [0.078869, 5.462127], [0.056929, 7.45609], [0.038827, 9.447771], [0.02443, 11.435579], [0.013583, 13.41602], [0.0061, 15.379678], [0.001734, 17.290693], [0.00011, 19]];
const CAS_PEAK = -1 / 6.5;   // cas cb0[1].x
const GRAIN = { colorAmount: 0.6, size: 1.25, intensity: 0.0008, mid: 0.65, range: 0.2, power: 3 };   // filmgrain cb0[0]、cb0[1]（power = −cb0[1].y）
const EXPO = { influence: 1, middleValue: 0.55, minExposure: -3.7, maxExposure: 10, minLuminance: 0.4649, maxLuminance: 10, minBrightness: 0.9, maxBrightness: 0.98, increaseSpeed: 2, decreaseSpeed: 1.5 };   // Tr2PPDynamicExposureEffect 类默认值
const TONE = { A: 0.125, B: 0.25, C: 0.1, D: 0.15, E: 0.021, F: 0.3, W: 2.5 };   // shoulderStrength、linearStrength、linearAngle、toeStrength、toeNumerator、toeDenominator、whiteScale
// 区域调色（客户端 dx9/postprocess/environmentvolumes/envvol_*.black → Tr2PostProcessAttributes，tonemapping 着色器的 COLOR_CORRECTION 分支执行）
// 文件里没写的字段 = 不调（6500 K、偏色 0、饱和度 / 对比度 1、增益 1）；gamma / offset 这几个文件里都没有
export const GRADES = {
  amarr: { temp: 7500, tint: 0.25, sat: 0.9, contrast: 1.05, gain: [1.15, 1.15, 0.7] },
  caldari: { temp: 5500, tint: 0.1, contrast: 1.05, gain: [0.85, 0.85, 1.3] },
  gallente: { tint: 0.1, contrast: 1.05, gain: [0.85, 1.175, 0.975] },
  minmatar: { tint: 0.25, gain: [1.2, 0.9, 0.9] },
  concord: { temp: 6000, tint: 0.3, sat: 0.8, contrast: 1.05, gain: [0.85, 0.925, 1.225] },
};
// 白平衡矩阵：照 tonemapping 反汇编（色温 ≠ 6500 或偏色 ≠ 0 才做）——日光 / 普朗克轨迹求源白点（< 4000 K 用普朗克），
// 沿等温线按偏色 × 0.05 挪，再 Bradford 色适应到 D65，前后是 sRGB ↔ XYZ。返回 3×3（行主序），作用在线性 sRGB 上
function whiteBalance(T, tint) {
  if (T === 6500 && !tint) return null;
  const inv = 1 / (T * 1.000556);
  let x = T <= 6996.10791 ? 0.244063 + inv * (99.11 + inv * (2967800 - inv * 4607000064)) : 0.23704 + inv * (247.48 + inv * (1901800 - inv * 2006400000));
  let y = -3 * x * x + 2.87 * x - 0.275;
  const T2 = T * T;
  // 反汇编只显示 6 位小数（0.000154 等），系数用普朗克轨迹近似式（Krystek）的全精度值
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T2) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T2);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T2) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T2);
  const den = 2 * u - 8 * v + 4, px = 3 * u / den, py = 2 * v / den;
  if (T < 4000) { x = px; y = py; }
  const ud = (-1137581184 - 1916156.25 * T - 1.53177 * T2) / (1412139.875 + 1189.62 * T + T2) ** 2;
  const vd = (1974715392 - 705674 * T - 308.607 * T2) / (6193636 - 179.456 * T + T2) ** 2;
  const n = Math.hypot(ud, vd), u2 = u - (vd / n) * tint * 0.05, v2 = v + (ud / n) * tint * 0.05;
  const d2 = 2 * u2 - 8 * v2 + 4;
  x += 3 * u2 / d2 - px; y += 2 * v2 / d2 - py;
  const W = [x / Math.max(y, 0), 1, (1 - x - y) / y];
  const mul = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const BR = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const BI = [[0.986993, -0.147054, 0.159963], [0.432305, 0.51836, 0.049291], [-0.008529, 0.040043, 0.968487]];
  const S2X = [[0.412391, 0.357584, 0.180481], [0.212639, 0.715169, 0.072192], [0.019331, 0.119195, 0.950532]];
  const X2S = [[3.24097, -1.537383, -0.498611], [-0.969244, 1.875968, 0.041555], [0.05563, -0.203977, 1.056972]];
  const cone = BR.map((r) => r[0] * W[0] + r[1] * W[1] + r[2] * W[2]), D65 = [0.941379, 1.040436, 1.089767];
  const D = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? D65[i] / cone[i] : 0)));
  return mul(X2S, mul(BI, mul(D, mul(BR, S2X))));
}
function createPost(renderer, fxDir) {
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return null;
  const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const mk = (uniforms, fs) => new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const qs = new THREE.Scene(); qs.add(quad);
  const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // postprocess/highpassfilter：inv = 1 ÷ 输出尺寸
  const high = mk({ tex: { value: null }, inv: { value: new THREE.Vector2() } }, `uniform sampler2D tex; uniform vec2 inv; varying vec2 vUv;
    const vec3 L = vec3(0.299, 0.587, 0.114);
    void main() {
      vec3 c = texture2D(tex, vUv).rgb; float l = dot(L, c);
      vec3 s; float k;
      s = texture2D(tex, vUv + vec2(inv.x, 0.0)).rgb; k = sqrt(dot(L, s * s)); if (k < l) { c = s; l = k; }
      s = texture2D(tex, vUv + vec2(0.0, inv.y)).rgb; k = sqrt(dot(L, s * s)); if (k < l) { c = s; l = k; }
      s = texture2D(tex, vUv + inv).rgb; k = sqrt(dot(L, s * s)); if (k < l) { c = s; l = k; }
      const float T = ${BLOOM.threshold.toFixed(4)};
      vec3 lin = mix(pow(abs(c + 0.055) * 0.947867, vec3(2.4)), c * 0.077399, vec3(lessThan(c, vec3(0.04045))));
      gl_FragColor = vec4(l < T ? vec3(0.0) : lin * max(1.0 - T / l, 0.0) * ${BLOOM.scale.toFixed(4)}, 1.0);
    }`);
  // postprocess/blur：dir = 方向 × (1 ÷ 尺寸)
  const blur = mk({ tex: { value: null }, dir: { value: new THREE.Vector2() } }, `uniform sampler2D tex; uniform vec2 dir; varying vec2 vUv;
    void main() {
      vec3 o = vec3(0.0);
      ${BLUR_TAPS.map(([w, x]) => `o += texture2D(tex, vUv + dir * ${x.toFixed(6)}).rgb * ${w.toFixed(6)};`).join('\n      ')}
      gl_FragColor = vec4(o, 1.0);
    }`);
  // 扭曲缓冲（跃迁隧道的 warptunneldistortion 等写入的屏幕偏移，单位像素）：合成时按它挪动场景的采样位置
  const tone = mk({ scene: { value: null }, bloom: { value: null }, expo: { value: null }, useExpo: { value: 0 }, useBloom: { value: 1 }, dist: { value: null }, useDist: { value: 0 }, inv: { value: new THREE.Vector2() },
    useCC: { value: 0 }, useWB: { value: 0 }, wb: { value: new THREE.Matrix3() }, cc: { value: new THREE.Vector4(1, 1, 1, 0) }, gain: { value: new THREE.Vector3(1, 1, 1) }, offset: { value: new THREE.Vector3() } },
    `uniform sampler2D scene, bloom, expo, dist; uniform float useExpo, useBloom, useDist, useCC, useWB; uniform vec2 inv; varying vec2 vUv;
    uniform mat3 wb; uniform vec4 cc; uniform vec3 gain, offset;   // cc = 饱和度、对比度、gamma
    const float A = ${TONE.A.toFixed(4)}, B = ${TONE.B.toFixed(4)}, C = ${TONE.C.toFixed(4)}, D = ${TONE.D.toFixed(4)}, E = ${TONE.E.toFixed(4)}, F = ${TONE.F.toFixed(4)}, W = ${TONE.W.toFixed(4)};
    vec3 U(vec3 x) { return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F; }
    void main() {
      vec4 dd = useDist > 0.5 ? texture2D(dist, vUv) : vec4(0.0);
      vec3 c;
      if (dd.z > 0.002) {
        // 隐形扭曲层写的（b = 1/256 × 层数，a = Σ色散系数）：照客户端 postprocess/distortion，R / G / B 按 1、0.5 + 0.5k、k 倍偏移分开采样，
        //   k = 1 − a / (b × 256)；偏移后的位置不在扭曲区里就不偏
        vec2 o = dd.xy * inv, u0 = vUv + o;
        float k = 1.0 - dd.w / (dd.z * 256.0);
        c = texture2D(dist, u0).z >= 0.0039 ? vec3(texture2D(scene, u0).r, texture2D(scene, vUv + o * (0.5 + 0.5 * k)).g, texture2D(scene, vUv + o * k).b) : texture2D(scene, vUv).rgb;
      } else c = texture2D(scene, vUv + dd.xy * inv).rgb;
      c = mix(pow(abs(c + 0.055) * 0.947867, vec3(2.4)), c * 0.077399, vec3(lessThan(c, vec3(0.04045))));
      float wInv = 1.0 / U(vec3(W)).x;
      vec3 b = texture2D(bloom, vUv).rgb * (useBloom * ${BLOOM.brightness.toFixed(4)});
      float exposure = useExpo > 0.5 ? ${EXPO.middleValue.toFixed(4)} / mix(0.5, texture2D(expo, vec2(0.0625, 0.5)).r, ${EXPO.influence.toFixed(4)}) : 1.0;
      c = (c + max(U(2.0 * b), 0.0) * wInv) * exposure;
      if (useCC > 0.5) {
        // 调色（反汇编顺序）：白平衡 → 饱和度（亮度权重 0.272229 / 0.674082 / 0.053690）→ 对比度（以 0.18 为中点的幂）→ gamma → 增益 + 偏移
        if (useWB > 0.5) c = wb * c;
        float l = dot(c, vec3(0.272229, 0.674082, 0.053690));
        c = max(mix(vec3(l), c, cc.x), 0.0);
        c = pow(c * 5.555555, vec3(cc.y)) * 0.18;
        c = pow(c, vec3(1.0 / cc.z));
        c = c * gain + offset;
      }
      c = max(U(2.0 * max(c, 0.0)), 0.0) * wInv;
      c = mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.003131))));
      c += fract(dot(gl_FragCoord.xy, vec2(0.754878, 0.569840))) * 0.003922 - 0.001961;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`);
  // postprocess/cas + postprocess/filmgrain（客户端两遍，这里合成一遍：两者都是逐像素的）
  //   颗粒：屏幕像素 ÷ 1.25 + 1000，按每帧随机角度旋转，B 样条双三次采样噪声图（512²，重复）；
  //   每通道 smoothstep((n − 0.45) ÷ 0.4)，按 0.6 向三通道平均靠拢（彩色颗粒）；强度 = 0.0008 × (1 − 线性色)³，加到线性色上
  //   随机角度：客户端 = hash(uint(时间 × 1024)) × 小常数（反汇编只显示 0.000000，看不出具体值），这里每帧取均匀随机角
  const grainTex = new THREE.TextureLoader().load(`${fxDir}post/film_grain_noise.png?v=1`);
  grainTex.wrapS = grainTex.wrapT = THREE.RepeatWrapping; grainTex.generateMipmaps = false; grainTex.minFilter = grainTex.magFilter = THREE.LinearFilter; grainTex.colorSpace = THREE.NoColorSpace;
  const fin = mk({ tex: { value: null }, grain: { value: grainTex }, inv: { value: new THREE.Vector2() }, rot: { value: new THREE.Vector2(1, 0) } },
    `uniform sampler2D tex, grain; uniform vec2 inv, rot; varying vec2 vUv;
    vec3 T(float x, float y) { return texture2D(tex, vUv + vec2(x, y) * inv).rgb; }
    vec3 bicubic(vec2 p) {
      p -= 0.5; vec2 i = floor(p), f = p - i, f2 = f * f, f3 = f2 * f;
      vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0, w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
      vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = w1 / g0 - 0.5, h1 = w3 / g1 + 1.5;
      vec4 q = (vec4(i.x + h0.x, i.y + h0.y, i.x + h1.x, i.y + h1.y) + 0.5) / 512.0;
      return g0.y * (g0.x * texture2D(grain, q.xy).rgb + g1.x * texture2D(grain, q.zy).rgb) + g1.y * (g0.x * texture2D(grain, q.xw).rgb + g1.x * texture2D(grain, q.zw).rgb);
    }
    void main() {
      vec3 c = T(0.0, 0.0), l = T(-1.0, 0.0), r = T(1.0, 0.0), u = T(0.0, -1.0), d = T(0.0, 1.0);
      float mn = min(min(min(c.g, r.g), l.g), min(u.g, d.g)), mx = max(max(max(c.g, r.g), l.g), max(u.g, d.g));
      float w = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-5), 0.0, 1.0)) * ${CAS_PEAK.toFixed(6)};
      c = clamp((w * (l + r + u + d) + c) / (4.0 * w + 1.0), 0.0, 1.0);
      vec2 p = gl_FragCoord.xy / ${GRAIN.size.toFixed(4)} + 1000.0;
      vec3 n = bicubic(vec2(p.x * rot.x - p.y * rot.y, p.x * rot.y + p.y * rot.x));
      n = clamp((n - ${(GRAIN.mid - GRAIN.range).toFixed(4)}) / ${(2 * GRAIN.range).toFixed(4)}, 0.0, 1.0); n = n * n * (3.0 - 2.0 * n);
      float avg = dot(n, vec3(1.0 / 3.0)); n = mix(vec3(avg), n, ${GRAIN.colorAmount.toFixed(4)});
      vec3 lin = mix(pow(abs(c + 0.055) * 0.947867, vec3(2.4)), c * 0.077399, vec3(lessThan(c, vec3(0.04045))));
      lin = clamp(n * clamp(pow(max(1.0 - lin, 1e-6), vec3(${GRAIN.power.toFixed(1)})) * ${GRAIN.intensity}, 0.0, 1.0) + lin, 0.0, 1.0);
      gl_FragColor = vec4(mix(1.055 * pow(lin, vec3(0.416667)) - 0.055, lin * 12.92, vec3(lessThan(lin, vec3(0.003131)))), 1.0);
    }`);
  // 动态曝光：直方图（64 × 1 浮点，每像素一个点加色混合）→ 测量（8 × 1，前后两帧来回读写）
  const expo = (() => {
    if (!gl.getExtension('EXT_float_blend')) return null;
    const compile = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, `#version 300 es
        precision highp float; precision highp int;
        uniform highp sampler2D uSource; uniform ivec2 uSize; uniform vec2 uLogLuminance;
        void main() {
          ivec2 pixel = ivec2(gl_VertexID % uSize.x, gl_VertexID / uSize.x);
          vec3 c = texelFetch(uSource, pixel, 0).rgb;
          vec3 lin = mix(pow(abs((c + 0.055) * 0.9478673), vec3(2.4)), c * 0.07739938, lessThan(c, vec3(0.04045)));
          float lum = dot(lin, vec3(0.2125, 0.7154, 0.0721));
          float t = (log(lum) - uLogLuminance.x) / (uLogLuminance.y - uLogLuminance.x);
          t = t >= 0.0 ? min(t, 1.0) : 0.0;
          int bin = min(int(t * 64.0), 63);
          gl_Position = vec4((float(bin) + 0.5) / 32.0 - 1.0, 0.0, 0.0, 1.0);
          gl_PointSize = 1.0;
        }`));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 color; void main() { color = vec4(1.0); }'));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { console.warn('dynamic exposure', e); return null; }
    const loc = { src: gl.getUniformLocation(prog, 'uSource'), size: gl.getUniformLocation(prog, 'uSize'), log: gl.getUniformLocation(prog, 'uLogLuminance') };
    const vao = gl.createVertexArray();
    const fRT = (w) => new THREE.WebGLRenderTarget(w, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    const hist = fRT(64), buf = [fRT(8), fRT(8)];
    let cur = 0, primed = false;
    const measure = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uHistogram: { value: hist.texture }, uPrevious: { value: null }, uTime: { value: 0 },
        uLuminance: { value: new THREE.Vector4(Math.log(EXPO.minLuminance), Math.log(EXPO.maxLuminance), EXPO.minBrightness, EXPO.maxBrightness) },
        uAdaptation: { value: new THREE.Vector4(EXPO.increaseSpeed, EXPO.decreaseSpeed, EXPO.minExposure, EXPO.maxExposure) } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; precision highp int;
        uniform highp sampler2D uHistogram, uPrevious; uniform vec4 uLuminance, uAdaptation; uniform float uTime;
        out vec4 color;
        float bins[64];
        float PercentileLuminance(uint c) {
          if (c == 0u) return 0.0;
          uint remaining = c; float pos = 0.0;
          for (int i = 0; i < 64; ++i) { uint count = uint(bins[i]); if (count >= remaining) { pos = (float(i) + float(remaining) / float(count)) * 0.015625; break; } remaining -= count; }
          return exp(mix(uLuminance.x, uLuminance.y, pos));
        }
        float PercentilePosition(uint c) {
          uint remaining = c;
          for (int i = 0; i < 64; ++i) { uint count = uint(bins[i]); if (remaining < count) return float(i) + float(remaining) / float(count); remaining -= count; }
          return 0.0;
        }
        void main() {
          int element = int(gl_FragCoord.x);
          float previous = texelFetch(uPrevious, ivec2(element, 0), 0).x;
          uint total = 0u;
          for (int i = 0; i < 64; ++i) { bins[i] = texelFetch(uHistogram, ivec2(i, 0), 0).x; total += uint(bins[i]); }
          uint low = uint(float(total) * uLuminance.z), high = uint(float(total) * uLuminance.w);
          float lumLow = PercentileLuminance(low), lumHigh = PercentileLuminance(high);
          float value = previous;
          if (element == 3) value = PercentilePosition(low);
          else if (element == 4) value = PercentilePosition(high);
          else if (element == 5) value = lumLow;
          else if (element == 6) value = lumHigh;
          else if (element == 1) value = uTime;
          else if (element == 0) {
            float average = mix(lumLow, lumHigh, 0.5);
            float scale = average < 0.0001 ? 5000.0 : 0.5 / average;
            scale = max(min(scale, exp2(uAdaptation.w)), exp2(uAdaptation.z));
            float target = 0.5 / scale;
            float speed = previous < target ? uAdaptation.x : uAdaptation.y;
            float lastTime = texelFetch(uPrevious, ivec2(1, 0), 0).x;
            float k = max(1.0 - exp(-speed * (uTime - lastTime)), 0.0);
            float adapted = mix(sqrt(previous), sqrt(target), k);
            value = adapted * adapted;
          }
          color = vec4(value);
        }`,
      depthTest: false, depthWrite: false,
    });
    const t0 = performance.now();
    return {
      // src：解析好的场景缓冲（sRGB 编码的半浮点）；返回本帧的曝光缓冲贴图
      run(src) {
        const tex = renderer.properties.get(src.texture).__webglTexture;
        if (!tex) return null;
        if (!primed) { const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(); renderer.setClearColor(0x000000, 0); for (const b of buf) { renderer.setRenderTarget(b); renderer.clear(); } renderer.setClearColor(cc, ca); primed = true; }
        renderer.setRenderTarget(hist);
        renderer.resetState();
        renderer.setRenderTarget(hist);
        gl.viewport(0, 0, 64, 1);
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
        gl.colorMask(true, true, true, true);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc.src, 0); gl.uniform2i(loc.size, src.width, src.height); gl.uniform2f(loc.log, Math.log(EXPO.minLuminance), Math.log(EXPO.maxLuminance));
        gl.drawArrays(gl.POINTS, 0, src.width * src.height);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
        renderer.resetState();
        const prev = buf[cur], next = buf[1 - cur];
        measure.uniforms.uPrevious.value = prev.texture;
        measure.uniforms.uTime.value = (performance.now() - t0) / 1000 + 1000;   // 缓冲初始为 0：第一帧直接到目标
        draw(measure, next);
        cur = 1 - cur;
        return next.texture;
      },
      dispose() { hist.dispose(); for (const b of buf) b.dispose(); gl.deleteProgram(prog); gl.deleteVertexArray(vao); },
    };
  })();
  let sceneRT = null, distRT = null, toneRT = null, bloomRT = [], size = '';
  const rt = (w, h, o = {}) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o });
  function resize(w, h) {
    if (`${w}x${h}` === size) return;
    size = `${w}x${h}`;
    for (const t of [sceneRT, distRT, toneRT, ...bloomRT]) t?.dispose();
    sceneRT = rt(w, h, { depthBuffer: true, samples: 4 });
    distRT = rt(w, h);
    toneRT = rt(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    bloomRT = [rt(Math.trunc(w / 2), Math.trunc(h / 2)), rt(Math.trunc(w / 2), Math.trunc(h / 2))];
    // 标准材质往这个缓冲里写 sRGB 编码值（three 只对 XR 渲染目标按贴图色彩空间输出）
    sceneRT.isXRRenderTarget = true; sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
  }
  const draw = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(qs, qc); };
  // distScenes：扭曲层场景（一个或数组），有可见内容时依次画进扭曲缓冲（先清成 0）；after：场景画完后往场景缓冲里再叠加的东西（恒星镜头光晕）
  function render(scene, camera, distScenes, after) {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    resize(v.x, v.y);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    after?.();
    const ds = [].concat(distScenes || []).filter((x) => x?.children.some((o) => o.visible));
    const useDist = ds.length > 0;
    if (useDist) {
      const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha(), ac = renderer.autoClear;
      renderer.setRenderTarget(distRT);
      renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.autoClear = false;
      for (const x of ds) renderer.render(x, camera);
      renderer.autoClear = ac;
      renderer.setClearColor(cc, ca);
    }
    tone.uniforms.dist.value = useDist ? distRT.texture : blackTex; tone.uniforms.useDist.value = useDist ? 1 : 0;
    tone.uniforms.inv.value.set(1 / v.x, 1 / v.y);
    // 泛光：高通到半分辨率 → 横向 → 纵向
    const [b0, b1] = bloomRT;
    high.uniforms.tex.value = sceneRT.texture; high.uniforms.inv.value.set(1 / b0.width, 1 / b0.height); draw(high, b0);
    blur.uniforms.tex.value = b0.texture; blur.uniforms.dir.value.set(1 / b0.width, 0); draw(blur, b1);
    blur.uniforms.tex.value = b1.texture; blur.uniforms.dir.value.set(0, 1 / b0.height); draw(blur, b0);
    tone.uniforms.scene.value = sceneRT.texture; tone.uniforms.bloom.value = b0.texture; tone.uniforms.useBloom.value = 1;
    let ex = null;
    try { ex = expo?.run(sceneRT) || null; } catch (e) { console.warn('dynamic exposure', e); }
    tone.uniforms.expo.value = ex || blackTex; tone.uniforms.useExpo.value = ex ? 1 : 0;
    draw(tone, toneRT);
    const a = Math.random() * Math.PI * 2;
    fin.uniforms.tex.value = toneRT.texture; fin.uniforms.inv.value.set(1 / v.x, 1 / v.y); fin.uniforms.rot.value.set(Math.cos(a), Math.sin(a));
    draw(fin, null);
  }
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blackTex.needsUpdate = true;
  // 区域调色：g = GRADES 里的一项或 null（不调）
  function setGrade(g) {
    const u = tone.uniforms;
    u.useCC.value = g ? 1 : 0;
    if (!g) return;
    const m = whiteBalance(g.temp ?? 6500, g.tint ?? 0);
    u.useWB.value = m ? 1 : 0;
    if (m) u.wb.value.set(...m[0], ...m[1], ...m[2]);   // Matrix3.set 按行主序
    u.cc.value.set(g.sat ?? 1, g.contrast ?? 1, g.gamma ?? 1, 0);
    u.gain.value.fromArray(g.gain || [1, 1, 1]);
    u.offset.value.fromArray(g.offset || [0, 0, 0]);
  }
  return { render, setGrade, dispose() { for (const t of [sceneRT, distRT, toneRT, ...bloomRT]) t?.dispose(); grainTex.dispose(); expo?.dispose(); } };
}

export function createView(host, hooks = {}, opt = {}) {
  let ownSide = 'A';
  const sideOf = (s) => (ownSide === 'A' ? s : s === 'A' ? 'B' : 'A');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true });
  } catch {
    return null;
  }
  let quality = opt.quality || 'auto', level = quality === 'low' ? 'low' : 'high';
  const brkOf = typeof opt.brackets === 'function' ? opt.brackets : null;   // 游戏图标查表（驾驶模拟）；没有时用战场模拟的图集
  const iconPx = brkOf ? 16 : ICON_PX;
  let dpr = level === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x04060b, 1);
  // 后处理（泛光 + 色调映射）：驾驶模拟打开（opt.post），只在高画质档用
  const post = opt.post ? createPost(renderer, opt.fx || 'assets/eveui/fx/') : null;
  // 船体 SSAO（客户端 Tr2SSAO / CACAO）：只在高画质档
  const ssao = post ? createSSAO(renderer) : null, ssaoV = new THREE.Vector2();
  const lightList = [];
  // 动态反射立方体（客户端 Tr2ReflectionProbe）：只在高画质档
  const refl = post ? createReflection(renderer) : null;
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
  // 恒星颜色照客户端 sun.py：远处 sunDiffuseColor = 恒星发光色（graphicIDs.emissiveColor）的色相、饱和度减半、明度 1.5；
  // 这里取黄色恒星 sun_yellow_01a（5, 4.47, 3.24）。quadv5 的直射光 = 恒星色 × NdotL ×（漫反射 + π × 高光），
  // three 的漫反射多除了 π，所以光强给 π
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
  {
    const e = [5, 4.470588, 3.235294], mx = Math.max(...e), mn = Math.min(...e), s = (mx - mn) / mx * 0.5;
    const c = e.map((x) => 1.5 * (1 - s * (mx - x) / (mx - mn || 1)));   // 同色相、饱和度 s、明度 1.5
    sun.color.setRGB(c[0], c[1], c[2]);
  }
  const sunDir = new THREE.Vector3(0.6, 0.5, 0.35);   // 指向恒星的方向（阴影要挪动 sun.position / target，方向单独存）
  sun.position.copy(sunDir);
  scene.add(sun.target);
  const amb = new THREE.AmbientLight(0x8090b0, 0.25);
  scene.add(sun, amb);
  // 天体（驾驶模拟，rec.cel）：恒星、行星、卫星；有恒星时方向光改成真实的恒星方向
  // 二次光照（sim-shl.js：行星 / 卫星反射的太阳光 → 每物体 SH）。shDir = 指向恒星的单位向量
  const shl = createSecondaryLighting(), shDir = new THREE.Vector3();
  const shKOf = (r, distM) => shIntensity(r, distM, camera.projectionMatrix.elements[0], ckVp.x);
  // 空间站 / 星门（非实例化网格）：强度写外观的统一量 k，系数按它自己的位置算
  const shStation = (def, p, dKm) => {
    const k = shl.has() && def.shl ? shKOf(def.r, dKm / KM) : 0;
    if (def.shl) def.shl.k.value = k;
    if (k > 0) shl.at(p, shDir.copy(sunDir).normalize(), def.r * 0.3, def.shl.sh.value);
  };
  // 实例化网格的接收者强度属性（eveShI）；炮塔 / 无人机还没算，给 0（不能缺：缺了会读到别的程序留下的通用属性值）
  const shAttr = (mesh, n) => {
    const g = mesh.geometry, a = g.getAttribute('eveShI');
    if (a && a.count >= n) return a;
    const b = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
    b.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('eveShI', b);
    return b;
  };
  const cels = createCelestials(scene, { load: (k) => loadModel(k), env: () => [env, envI], shade: shStation });   // 空间站 / 星门模型用舰船的加载器和环境反射
  // 恒星镜头光晕（sim-flare.js）：场景之后、泛光之前叠加
  const flare = opt.fx ? createFlare(renderer, scene, camera, `${opt.fx}lensflare/`) : null;
  // 跃迁隧道（驾驶模拟：hooks.warpFx() 给出自己船的跃迁状态）
  const tunnel = opt.fx && hooks.warpFx ? createWarpTunnel(scene, `${opt.fx}warp/`) : null;
  // 环绕镜头的抖动（evecamera/shaker.py 的 ShakeController + baseSpaceCamera._UpdateCameraNoiseOffset，见 sim-jump.js createShaker）
  const orbitShake = createShaker(), shakeQ = new THREE.Quaternion(), shakeV = new THREE.Vector3();
  let warpShakeT = -1;
  function warpFrame(now, dt, noShake) {
    const ws = tunnel ? hooks.warpFx() : null;
    tunnel?.update(camera, ws);
    // Warp.py ShakeCamera：跃迁循环里每次（旧版隧道 warptunnel.black 每 SleepSim(1000)）重发行为 'Warp'：
    //   scaleCurve 线性 (0, 镜头当前 noiseScale) (0.5, 2 × shakeFactor) (5, 0)，没有 dampCurve → noiseDamp = 1.1；
    //   循环结束 EndWarpShake → EndCameraShake('Warp')。shakeFactor = ws.shake（0.7 × rumbleFactor，sim-warp.js warpShake）
    if (ws) {
      if (warpShakeT < 0 || now - warpShakeT >= 1000) {
        warpShakeT = now;
        orbitShake.shake(shakeBehavior('Warp', { scaleCurve: linearCurve([[0, orbitShake.noiseScale], [0.5, 2 * ws.shake], [5, 0]]) }), now);
      }
    } else if (warpShakeT >= 0) { warpShakeT = -1; orbitShake.end('Warp', now); }
    if (noShake) return false;
    // 偏移加在注视点上（_AddToAtOffset），画完这一帧再把镜头朝向复原
    const off = orbitShake.offset(now, dt, camera.position, controls.target, shakeV);
    if (!off) return false;
    shakeQ.copy(camera.quaternion);
    camera.lookAt(off.add(controls.target));
    return true;
  }
  // 恒星阴影（Tr2ShadowMap.cpp）：客户端是 2048 边长的级联阴影，固定分割 SetStaticShadowSplits（每级远端 25、75、150 … 1228800 米），
  //   每级取该段视锥的 8 个角，在光源空间求包围盒：半径 = ceil(最远两角距离 / 2)（米），中心 x、y 按纹素（2 × 半径 / 2048）取整防闪烁，
  //   z 同样 中心 ± 半径（往太阳方向拉长的那行被注释掉了）。这里只做镜头注视点所在的那一级（盖住看着的那艘船），别的距离不投影；
  //   客户端之后还有屏幕空间的 PCF（9 个旋转抖动 + 时间滤波）和降噪，这里用 three 的 PCFSoft 代替
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.shadow.mapSize.set(2048, 2048);
  const SPLITS = [25, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 76800, 153600, 307200, 614400, 1228800];
  const shM = new THREE.Matrix4(), shMi = new THREE.Matrix4(), shC = Array.from({ length: 8 }, () => new THREE.Vector3()), shV = new THREE.Vector3(), shO = new THREE.Vector3();
  function fitShadow(on) {
    if (sun.castShadow !== on) sun.castShadow = on;
    const L = shV.copy(sunDir).normalize();
    if (!on) { sun.position.copy(L); sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld(); return; }
    const D = camera.position.distanceTo(controls.target) * 1000;
    let k = SPLITS.findIndex((z) => z >= D);
    if (k < 0) k = SPLITS.length - 1;
    const zs = [k ? SPLITS[k - 1] : camera.near * 1000, SPLITS[k]], th = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera.updateMatrixWorld();
    let n = 0;
    for (const z of zs) for (const sx of [-1, 1]) for (const sy of [-1, 1]) shC[n++].set(sx * z * th * camera.aspect, sy * z * th, -z).multiplyScalar(1 / 1000).applyMatrix4(camera.matrixWorld);
    // 光源空间：从恒星方向看向原点（和 three 的阴影相机同一个基，up = +Y）
    shM.lookAt(L, shO.set(0, 0, 0), camera.up.clone().set(0, 1, 0));
    shMi.copy(shM).transpose();
    let maxD = 0;
    const lo = [Infinity, Infinity, Infinity], hi2 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) maxD = Math.max(maxD, shC[i].distanceTo(shC[j]));
      const p = shO.copy(shC[i]).applyMatrix4(shMi);
      for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p.getComponent(q)); hi2[q] = Math.max(hi2[q], p.getComponent(q)); }
    }
    const R = Math.ceil(maxD * 1000 / 2) / 1000, tex = 2 * R / 2048;   // 千米
    const c = shO.set((lo[0] + hi2[0]) / 2, (lo[1] + hi2[1]) / 2, (lo[2] + hi2[2]) / 2);
    c.x = Math.floor(c.x / tex + 0.5) * tex; c.y = Math.floor(c.y / tex + 0.5) * tex;
    c.applyMatrix4(shM);
    sun.target.position.copy(c); sun.target.updateMatrixWorld();
    sun.position.copy(c).addScaledVector(L, 2 * R);
    const cam = sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = R; cam.far = 3 * R;
    cam.updateProjectionMatrix();
    sun.shadow.normalBias = tex * 1.5;
    sun.shadow.bias = -0.0002;
  }
  // 图片立方体（CubeTexture）→ PMREM，按世界方向原样采样：three 对图片立方体一律按 X 镜像取（flipEnvMap = −1，PMREM 的 fromCubemap 也是），
  //   客户端是直接按世界方向取，所以画一个原样采样的背景盒子再 fromScene（渲染目标的约定，不翻转）
  function pmremRaw(pm, cube) {
    const s = new THREE.Scene();
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.ShaderMaterial({
      uniforms: { map: { value: cube } },
      vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform samplerCube map; varying vec3 vD; void main() { gl_FragColor = vec4(textureCube(map, vD).rgb, 1.0); }',
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    }));
    s.add(m);
    const rt = pm.fromScene(s, 0, 0.1, 10);
    m.geometry.dispose(); m.material.dispose();
    return rt;
  }
  // 换环境反射贴图（只在变了时改材质）
  function setEnvTex(t) {
    if (!t || env === t) return;
    env = t;
    for (const set of [models, tModels, dModels]) for (const m of set.values()) for (const mt of m.def?.materials || []) { mt.envMap = t; mt.needsUpdate = true; }
  }
  const reflMats = () => { const a = []; for (const set of [models, tModels, dModels]) for (const m of set.values()) for (const mt of m.def?.materials || []) a.push(mt); return a; };
  let reflSave = null;
  // 画反射面时：材质反射强度压到 min(0.8, 1/强度²)（EveSpaceScene::GetReflectionIntensityInReflections），关掉 SSAO 和船体点光（它们按主视角算的）
  const reflBefore = () => { reflSave = [SHIP_AO.on.value, SHIP_LIGHTS.n.value]; SHIP_AO.on.value = 0; SHIP_LIGHTS.n.value = 0; const k = envI ? Math.min(0.8, 1 / (envI * envI)) : 0; for (const mt of reflMats()) mt.envMapIntensity = k; };
  const reflAfter = () => { SHIP_AO.on.value = reflSave[0]; SHIP_LIGHTS.n.value = reflSave[1]; for (const mt of reflMats()) mt.envMapIntensity = envI; };
  function celUpdate() {
    const d = cels.update(camera, ORG);
    if (d) { sunDir.copy(d); sky.material.uniforms.sun.value.copy(d); }
  }
  let env = null, envI = 1, envStatic = null;   // 环境反射贴图（高画质档换成动态立方体）、强度（场景的 reflectionIntensity）；envStatic：星系的 _refl 立方体
  // 载入模型时套上当前的环境反射（星空晚到时下面统一换）
  const loadModel = (k) => loadShipModel(k, renderer, env).then((def) => { if (def) for (const mt of def.materials) { mt.envMap = env; mt.envMapIntensity = envI; } return def; });
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
    envStatic = env;
    pm.dispose();
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
  // 游戏星空（opt.skybox = tools/ui-assets/fetch.mjs --sky 转换的目录）：照客户端 EveSpaceScene 的背景着色器 background.fx 画——
  //   星云立方体（HDR，sRGB 编码存）+ 三层平铺星点（StarMap 按立方体面坐标平铺 4 / 5 / 6 次，
  //   反射立方体的 alpha 按 AlphaBlend1 / 2 的区间决定每层星点在哪里出现），整体 × Tint × nebulaIntensity；
  //   船体环境反射用同一场景的反射立方体（客户端 EveSpaceSceneEnvMap = envMap1ResPath，即 *_cube_refl），乘 reflectionIntensity
  let skyCube = null, skyState = opt.skybox ? 'loading' : 'ok';
  const bg = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16));
  bg.renderOrder = -11;
  bg.frustumCulled = false;
  bg.visible = false;
  scene.add(bg);
  // 近处闪烁星精灵（客户端 EveStarfield，sim-stars.js）：opt.starfield = { seed: 星座 ID, sec: 安全等级 }（已知空间的星系；没有 = 不画）
  const stars = opt.fx ? createStarfield(opt.fx) : null;
  if (stars) { scene.add(stars.mesh); if (opt.starfield) stars.set(opt.starfield.seed, starCount(opt.starfield.sec)); }
  // 镜头周围的太空尘埃（客户端挂在镜头上的 dustfield.red，sim-dust.js）：只在有自己的船、镜头看着它时显示
  const dust = opt.fx ? createDustfield(opt.fx) : null;
  if (dust) scene.add(dust.mesh);
  const dustP = new THREE.Vector3(), dustQ = new THREE.Vector3(), dustC = [0, 0, 0], dustV = [0, 0, 0];
  if (opt.skybox) {
    const dir = opt.skybox.replace(/\/?$/, '/');
    const cube = (path, cs, ext = 'webp') => new Promise((ok, no) => new THREE.CubeTextureLoader().setPath(path)
      .load(['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => `${f}.${ext}`), (t) => { t.colorSpace = cs; ok(t); }, undefined, no));
    const tex2d = (url) => new Promise((ok, no) => new THREE.TextureLoader().load(url, ok, undefined, no));
    Promise.all([
      // 星云先用 AVIF（WebP 在暗部压出方块，见 tools/ui-assets/sky.py），浏览器不支持 / 没有这个文件再用 WebP
      cube(dir, THREE.SRGBColorSpace, 'avif').catch(() => cube(dir, THREE.SRGBColorSpace)), cube(dir + 'refl/', THREE.NoColorSpace), tex2d(dir + '../stars.webp'),
      fetch(dir + 'scene.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      new Promise((ok) => new THREE.ImageLoader().load(dir + '../stars-mips.webp?v=1', ok, undefined, () => ok(null))),
    ]).then(([neb, refl, star, sc, mipAtlas]) => {
      star.wrapS = star.wrapT = THREE.RepeatWrapping;
      star.flipY = false;   // 客户端按 D3D 的 uv（v 向下）采样星点平铺图
      star.colorSpace = THREE.SRGBColorSpace;   // background.fx 的 StarMap 带 Tr2sRGB 注解（效果文件 isSRGB = 1）：先按 sRGB 解码再用
      star.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());   // 采样器 EveSpaceSceneEnvMapSampler：各向异性 16、三线性、循环
      // 各层 mip 用 DDS 自带的（stars-mips.webp：1024² … 1² 从左到右排）。客户端屏幕上一般取到第 2 层左右，
      //   这些 mip 比浏览器按线性空间生成的暗得多（第 2 层平均亮度约 40%），自己生成的话星点会偏亮、偏多
      if (mipAtlas && star.image?.width === mipAtlas.width) {
        const lv = [star.image];
        for (let s = mipAtlas.width >> 1, x = 0; s >= 1; x += s, s >>= 1) {
          const c = document.createElement('canvas');
          c.width = c.height = s;
          c.getContext('2d').drawImage(mipAtlas, x, 0, s, s, 0, 0, s, s);
          lv.push(c);
        }
        star.mipmaps = lv;
        star.generateMipmaps = false;
      }
      star.needsUpdate = true;
      const v4 = (a, d) => new THREE.Vector4(...(a || d));
      bg.material = new THREE.ShaderMaterial({
        uniforms: {
          neb: { value: neb }, alpha: { value: refl }, star: { value: star },
          sp: { value: v4(sc.starParameters, [4, 5, 6, 0.8]) }, ab1: { value: v4(sc.alphaBlend1, [0.0615, 0.7616, 0.7004, 1]) }, ab2: { value: v4(sc.alphaBlend2, [0.2198, 0.8375, 0, 0]) },
          // nebulaIntensity：m01 的场景文件里没写，按 1 处理（引擎默认值没拿到）
          tint: { value: new THREE.Vector3(...(sc.tint || [1, 1, 1]).slice(0, 3)).multiplyScalar(sc.nebulaIntensity ?? 1) },
        },
        vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        // 第 2、3 层星点的平移量：场景文件里没写，用 background.fx 的默认值（实机抓帧 frame32757 背景 PS cb0[1]）
        fragmentShader: `uniform samplerCube neb, alpha; uniform sampler2D star; uniform vec4 sp, ab1, ab2; uniform vec3 tint; varying vec3 vD;
          const vec4 OFS = vec4(0.1234, 0.54324, 0.33443, 0.98877);
          void main() {
            vec3 d = vD;   // 客户端按世界方向直接采样（D3D 和 WebGL 立方体贴图的选面、面内 uv 约定相同）
            vec3 a = abs(d);
            float ma = max(max(a.x, a.y), a.z);
            vec3 sel = vec3(greaterThanEqual(a, vec3(ma)));
            vec2 uv = (vec2(dot(sel, vec3(d.z, -d.z, d.x)), dot(sel, vec3(d.y, d.x, -d.y))) / ma + 1.0) * 0.5;
            vec3 s1 = texture2D(star, uv * sp.x).rgb, s2 = texture2D(star, uv * sp.y + OFS.xy).rgb, s3 = texture2D(star, uv * sp.z + OFS.zw).rgb;
            float m = textureCube(alpha, d).a;
            vec2 t = 1.0 - clamp((vec2(m) - ab1.xz) / (ab1.yw - ab1.xz), 0.0, 1.0);
            float t3 = 1.0 - clamp((m - ab2.x) / (ab2.y - ab2.x), 0.0, 1.0);
            vec3 c = max((sp.w * (s1 * t.x + s2 * t.y + s3 * t3) + textureCube(neb, d).rgb) * tint, 0.0);
            gl_FragColor = vec4(mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.0031308)))), 1.0);
          }`,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
      });
      bg.visible = true;
      skyCube = neb;
      const pm = new THREE.PMREMGenerator(renderer);
      // EveSpaceSceneEnvMap 在 quadv5 / 炮塔 quadv5 里带 Tr2sRGB=1 注解（_refl.dds 是 DXT3），客户端采样时先 sRGB → 线性；
      // refl 本身还给背景着色器取 alpha、给跃迁隧道用，所以另做一份 sRGB 的给船体反射
      const reflS = refl.clone();
      reflS.colorSpace = THREE.SRGBColorSpace;
      reflS.needsUpdate = true;
      env = pmremRaw(pm, reflS).texture;
      envStatic = env;
      reflS.dispose();
      tunnel?.setEnv(refl);
      bubbleEnv = refl;
      pm.dispose();
      envI = sc.reflectionIntensity ?? 1;
      for (const set of [models, tModels, dModels]) for (const m of set.values()) for (const mt of m.def?.materials || []) { mt.envMap = env; mt.envMapIntensity = envI; mt.needsUpdate = true; }
      amb.intensity = 0;   // quadv5 没有环境光常量，暗面只靠环境立方体
      sky.visible = false;
      skyState = 'ok';
    }).catch(() => { skyState = 'fail'; });
  }

  // 总览图标：屏幕空间的点精灵，图集里按类别取图
  const brGeo = new THREE.BufferGeometry();
  let brCap = 0;
  const brMat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: null }, grid: { value: new THREE.Vector2(brkOf ? BR_COLS : BRACKETS.length, brkOf ? BR_COLS : 1) }, size: { value: iconPx * dpr }, fade: { value: 1 } },
    vertexShader: `attribute vec4 tint; attribute float icon; varying vec4 vTint; varying float vIcon; uniform float size;
      void main() { vTint = tint; vIcon = icon; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D atlas; uniform vec2 grid; uniform float fade; varying vec4 vTint; varying float vIcon;
      void main() { vec4 t = texture2D(atlas, (vec2(mod(vIcon, grid.x), floor(vIcon / grid.x)) + gl_PointCoord) / grid); if (t.a * vTint.a * fade < 0.02) discard; gl_FragColor = vec4(t.rgb * vTint.rgb, t.a * vTint.a * fade); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const brPts = new THREE.Points(brGeo, brMat);
  brPts.frustumCulled = false;
  brPts.renderOrder = 5;
  brPts.visible = false;
  scene.add(brPts);
  // 状态旗（客户端 inSpaceBracket.UpdateFlagAndBackground + stateFlag.FlagIcon）：图标左上角 (9, 8) 处 9×9 的小方块，
  // 底色 0.75 + 8×8 白色符号；跟总览同一套——敌方按 −10 声望（红 0.75,0,0，符号 4 = 减号），友方按同舰队（紫 0.6,0.15,0.9，符号 1 = 人形）
  const FLAGS = [['rgba(191, 0, 0, 0.75)', 4], ['rgba(153, 38, 230, 0.75)', 1]];
  const flCanvas = document.createElement('canvas');
  flCanvas.width = 18 * FLAGS.length; flCanvas.height = 18;
  const flTex = new THREE.CanvasTexture(flCanvas);
  flTex.flipY = false; flTex.colorSpace = THREE.SRGBColorSpace; flTex.generateMipmaps = false;
  flTex.magFilter = flTex.minFilter = THREE.NearestFilter;
  FLAGS.forEach(([bg, n], k) => {
    const x = flCanvas.getContext('2d');
    x.fillStyle = bg; x.fillRect(k * 18, 0, 18, 18);
    const im = new Image();
    im.onload = () => { x.imageSmoothingEnabled = false; x.drawImage(im, k * 18 + 1, 1, 16, 16); flTex.needsUpdate = true; };
    im.src = `${opt.ui || 'assets/eveui/'}classes/flagicon/8/${n}.png?v=1`;
  });
  flTex.needsUpdate = true;
  const flGeo = new THREE.BufferGeometry();
  let flCap = 0;
  const flMat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: flTex }, n: { value: FLAGS.length }, size: { value: 9 * dpr }, off: { value: new THREE.Vector2() } },
    vertexShader: `attribute vec2 fl; varying vec2 vFl; uniform float size; uniform vec2 off;
      void main() { vFl = fl; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.xy += off * gl_Position.w; }`,
    fragmentShader: `uniform sampler2D atlas; uniform float n; varying vec2 vFl;
      void main() { vec4 t = texture2D(atlas, vec2((vFl.x + gl_PointCoord.x) / n, gl_PointCoord.y)); gl_FragColor = vec4(t.rgb, t.a * vFl.y); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const flPts = new THREE.Points(flGeo, flMat);
  flPts.frustumCulled = false;
  flPts.renderOrder = 6;
  scene.add(flPts);
  // 游戏图标（opt.brackets(typeID) → 相对 opt.ui 的贴图路径，客户端 bracketMgr.GetBracketIcon 的查表结果）：
  // 用到哪张加载哪张，画进 16×16 格（每格 32 像素，16 像素原图放大 2 倍）的图集；屏幕上按客户端的 16×16 画
  const brSlots = new Map();
  let brCanvas = null, brTex = null;
  function brSlot(path) {
    if (!path) return -1;
    let k = brSlots.get(path);
    if (k != null) return k;
    k = brSlots.size;
    if (k >= BR_COLS * BR_COLS) return -1;
    brSlots.set(path, k);
    const im = new Image();
    im.onload = () => { const x = brCanvas.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(im, (k % BR_COLS) * 32, Math.floor(k / BR_COLS) * 32, 32, 32); brTex.needsUpdate = true; };
    im.src = `${opt.ui || 'assets/eveui/'}${path}?v=1`;
    return k;
  }
  if (brkOf) {
    brCanvas = document.createElement('canvas');
    brCanvas.width = brCanvas.height = BR_COLS * 32;
    brTex = new THREE.CanvasTexture(brCanvas);
    brTex.flipY = false; brTex.colorSpace = THREE.SRGBColorSpace; brTex.generateMipmaps = false;
    brTex.magFilter = brTex.minFilter = THREE.LinearFilter;
    brMat.uniforms.atlas.value = brTex; brPts.visible = true;
  } else bracketAtlas().then((t) => { brMat.uniforms.atlas.value = t; brPts.visible = true; });

  // 舰船模型：每种外观一个 InstancedMesh
  let shipIndex = null;
  loadShipIndex().then((x) => { shipIndex = x; lastN = -1; });
  const models = new Map();   // 外观键 → { state: 'loading'|'ok'|'none', mesh, def, units: [i] }
  const keyOf = (i) => shipIndex?.types?.[rec.units[i].ship]?.m || null;
  const iconOf = (i) => (brkOf ? brSlot(brkOf(rec.units[i].ship)) : Math.max(0, BRACKETS.indexOf(shipIndex?.types?.[rec.units[i].ship]?.b || 'frigate')));
  const wreckIcon = () => (brkOf ? brSlot(WRECK_PATH) : WRECK_ICON);
  const radiusOf = (i) => (shipIndex?.models?.[keyOf(i)]?.r || rec.units[i].radius || 50) * KM;
  // 残骸（客户端 Wreck：船爆了换成独立的残骸类型 / 模型）：护卫舰级 wreck_s，驱逐 ~ 巡洋 / 工业 / 采矿驳船 wreck_m，战巡以上 wreck_l
  // （旗舰各有专属残骸外形，还没转换，暂用 wreck_l）
  const WRECK_OF = { frigate: 's', rookie: 's', shuttle: 's', capsule: 's', miningfrigate: 's', destroyer: 'm', cruiser: 'm', industrial: 'm', miningbarge: 'm' };
  const wreckKeyOf = (i) => (shipIndex?.wrecks && !rec.units[i].drone ? shipIndex.wrecks[WRECK_OF[shipIndex.types?.[rec.units[i].ship]?.b] || 'l'] || null : null);
  const wreckReady = (i) => models.get(wreckKeyOf(i))?.state === 'ok';
  // 炮塔（客户端 TurretSet.FitTurrets）：高槽 N 的炮 / 发射器挂到船体上名字以 locator_turret_N 开头的每个挂点（a / b / c 都挂），
  // 挂点矩阵带朝向和缩放；模型是 EveTurretSet 的几何，静止姿态（还没做转向目标）
  const tModels = new Map();   // 炮塔模型键 → { state, def, mesh, cap, list }
  const mounts = [];           // 每艘船：[{ k, mat（船体局部，客户端坐标原样）, ri（装备序号）}]
  function tModel(k) {
    let m = tModels.get(k);
    if (!m) {
      m = { state: 'loading', def: null, mesh: null, cap: 0, list: [] };
      tModels.set(k, m);
      loadModel(k).then((def) => { if (!def) { m.state = 'none'; return; } m.def = def; m.state = 'ok'; });
    }
    return m;
  }
  function mountsOf(i, def) {
    if (mounts[i]) return mounts[i];
    const tur = shipIndex?.turrets, L = def?.loc?.turrets;
    const out = [];
    if (tur && L?.length) {
      (rec.units[i].rack || []).forEach((r, ri) => {
        const k = r.slot === 'high' ? tur[r.type] : null;
        if (!k) return;
        const n = Number(String(r.key).split(':')[1]) + 1;
        for (const [nm, a] of L) if (parseInt(nm, 10) === n) out.push({ k, mat: new THREE.Matrix4().fromArray(a), ri });
        tModel(k);
      });
    }
    return (mounts[i] = out);
  }
  // 某件装备的炮塔在世界里的位置（炮塔模型包围球心）；第 pick 个挂点（同一槽 a / b 轮流）；没有炮塔模型时返回 null
  function mountAt(i, ri, pick, out) {
    const L = mounts[i], d = drawn[i];
    if (!L?.length || !d?.alive || ri == null || ri < 0) return null;
    const mine = L.filter((x) => x.ri === ri);
    if (!mine.length) return null;
    const mt = mine[Math.abs(pick | 0) % mine.length], c = tModels.get(mt.k)?.def?.c || [0, 0, 0];
    out.set(c[0], c[1], c[2]).applyMatrix4(mt.mat).multiplyScalar(KM);
    if (heading[i]) out.applyQuaternion(heading[i]);
    out.x += d.x; out.y += d.y; out.z += d.z;
    return out;
  }
  function syncModels() {
    if (!shipIndex || !rec) return;
    const want = new Map(), wrecks = new Set();
    rec.units.forEach((u, i) => {
      const k = keyOf(i); if (k) (want.get(k) || want.set(k, []).get(k)).push(i);
      const w = wreckKeyOf(i); if (w) { wrecks.add(w); (want.get(w) || want.set(w, []).get(w)).push(i); }
    });
    for (const [k, units] of want) {
      let m = models.get(k);
      if (!m) {
        m = { state: 'loading', units, mesh: null, wreck: wrecks.has(k) };
        models.set(k, m);
        loadModel(k).then((def) => {
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
  // 无人机 / 舰载机模型：按需加载，实例数按当前在太空中的数量增长
  const dModels = new Map();
  function droneModel(k) {
    let m = dModels.get(k);
    if (!m) {
      m = { state: 'loading', cap: 0, mesh: null, def: null };
      dModels.set(k, m);
      loadModel(k).then((def) => { if (!def) { m.state = 'none'; return; } m.def = def; m.state = 'ok'; });
    }
    return m;
  }
  function progress() {
    let done = 0;
    for (const m of models.values()) if (m.state !== 'loading') done++;
    hooks.onProgress?.(done, models.size);
  }
  // 船身叠加特效（EveMeshOverlayEffect，dx9/model/effect/*_skinned.black）：船体网格再画一遍加色层。
  // 画法照客户端着色器 spaceobject/v3/skinned_fxv3（反汇编）：
  //   颜色 = 菲涅尔 × Layer1 × Layer2 × 遮罩 × BaseColor；UV = uv × Transform.xy + Transform.zw + Scroll.xy × 时间 + Scroll.zw
  //   菲涅尔：d = sat(V·N − F.z)，x = (1 − d)^F.x；F.y ≥ 0 → x × F.y（边缘亮），F.y < 0 → (1 − min(x, 1)) × (−F.y)（正面亮）
  //   BaseColor = 颜色曲线 × 绑定倍数 gain（文件里的 TriValueBinding.scale）
  // keys = 颜色曲线（秒, rgb），每个周期重播一次；曲线是否拉伸到模块周期（timeScale）在 effects.fsdbinary 里，还没解出来，这里按曲线自身时长
  const HFX = {
    sb: { keys: [[0, [0, 0, 0]], [0.1, [0.0706, 0.098, 0.1333]], [1, [0, 0, 0]]], gain: 5000, F: [0.1, -0.1, 0.1], l1: 'caustics', l2: 'waves', mask: 'caustics2', t1: [3, 3, 0, 0], s1: [0, 0, 5, 0], t2: [3, 3, 0, 0], s2: [0, -1, 0, 0] },
    ar: { keys: [[0, [0, 0, 0]], [0.1, [0.1059, 0.1333, 0.1059]], [6, [0, 0, 0]]], gain: 200, F: [4, 5, 0.1], l1: 'build3', l2: 'build3', mask: '', t1: [3, 3, 0, 0], s1: [0, 0, 0, 0], t2: [0.5, 0.5, 0, 0], s2: [0, -0.025, 0, 0] },
    hr: { keys: [[0, [0, 0, 0]], [0.1, [1, 0.749, 0.3412]], [6, [0, 0, 0]]], gain: 200, F: [4, 5, 0.1], l1: 'build3', l2: 'build3', mask: 'caustics3', t1: [3, 3, 0, 0], s1: [0.2, 0, 0, 0], t2: [3, -3, 0, 0], s2: [-0.2, 0.1, 0, 0] },
    sh: { keys: [[0, [0, 0, 0]], [0.5, [0.5529, 0.7333, 0.9686]], [9.5, [0.5529, 0.7333, 0.9686]], [10, [0, 0, 0]]], gain: 5, F: [0.1, -0.1, -0.744], l1: 'caustics2', l2: 'caustics2', mask: 'caustics2', t1: [1, 1, 0, 0], s1: [0.05, 0.1, 5, 0], t2: [1, -1, 0, 0], s2: [0.05, 0.1, 0, 0], loop: true },
    ah: { keys: [[0, [0, 0, 0]], [0.5, [0.1294, 0.1059, 0.0706]], [19.5, [0.4392, 0.3647, 0.2549]], [20, [0, 0, 0]]], gain: 5, F: [12, 20, 0.1], l1: 'caustics2', l2: 'waves', mask: 'caustics2', t1: [1, 1, 0, 0], s1: [0, 0, 5, 0], t2: [0, 0.5, 0, 0], s2: [0, -0.3, 0, 0], loop: true },
  };
  // 紧急船体激能器（effects.Invulnerability → fisfx/module/invulnerability_ov_t1a.black）：两层 fx3dv5（spaceobject/v5/fx/fx3dv5 反汇编）
  //   菲涅尔同上（F.y = 亮度曲线 × 绑定倍数）；n = 体积(p×L1T.x + L1T.yzw + frac(L1S.x×时间) + L1S.yzw).x × 体积(同理 L2).y，p = 模型空间坐标
  //   遮罩 = 2D(|p − L3C| × L3T.xy + L3T.zw + frac(L3S.xy×时间) + L3S.zw)；颜色 = n × 遮罩.rgb × FxColor + 遮罩.a × BaseColor（已核对像素着色器）
  //   曲线：Brightness（Hermite）绑到第一层 F.y ×5、第二层 ×1.42；UvOffset 0→1（10 秒）绑到第一层 L1S.w ×0.75、L2S.w ×1
  const BRIGHT = [[0, 0, 0, 0, 2], [0.35484, 0.745, 1.50169, 0.82593, 2], [1, 1, 0, 0, 1], [9, 1, 0, 0, 1], [9.57309, 0.72643, -0.7423, -0.99647, 2], [10, 0, 0, 0, 2]];
  const HFX3 = {
    hi: { len: 10, curve: BRIGHT, passes: [
      { F: [2, 5, 0], l1t: [10, 0, 0, 0], l1s: [-0.5, 0, 0, 0], l1w: 0.75, l2t: [14, 0, 0, 0], l2s: [0.5, 0, 0, 0], l2w: 1, l3t: [-0.5, -0.25, -0.5, 0.75], l3s: [0.5, 0.33, 0, 0], base: [0.5059, 0.7843, 1, 1], fx: [0.6, 0.8863, 1, 1], mask: 'gradientbeat_02e' },
      { F: [0.1, 1.42, 0], l1t: [7, 0, 0, 0], l1s: [-0.5, 0, 0, 1.416], l1w: 0, l2t: [12, 0, 0, 0], l2s: [0.5, 0, 0, 1], l2w: 0, l3t: [-0.333, -0.333, 0, 0], l3s: [0.1, 0.2, 0, 0], base: [0.2667, 0.4314, 0.5333, 1], fx: [0.2196, 0.3176, 0.4471, 1], mask: 'gradientbeat_02f' },
    ] },
  };
  for (const h of Object.values(HFX)) h.len = h.keys[h.keys.length - 1][0];
  Object.assign(HFX, HFX3);
  // ---------- 隐形 / 解除隐形 ----------
  // 客户端：effects.Cloak / Uncloak（eve/client/script/environment/effects/cloaking.py）往船上挂 EveMeshOverlayEffect
  //   fisfx/cloaking/cloaking.black（effects.json：Cloak / Uncloak → graphicID 21040；CloakingCovertOps → 21015 cloaking_pentagon；
  //   CloakingPrototype → 21030 cloaking_triangle），时长都是 6000 ms。
  // 曲线（.black 的 curveSet，Tr2CurveScalar）：
  //   CloakAmount 0 → 1.13（0–4.9 秒线性，之后保持）→ 船的 clipSphereFactor（溶解球半径系数）
  //   ActivationAmount 1 → 0（0–6 秒线性）→ activationStrength（EveMobile.DisplayChildren：> 0.5 才画炮塔 / 尾焰 / 子物体）
  //   FresnelTweaker 0.35 → 1.3 → 0.35（Hermite，6 秒循环）→ CloakColor 层的 FresnelFactors.y
  //   Calibration ±0.1（60 秒循环：0–4.5 秒 +0.1，5–59 秒 −0.1）→ 扭曲层 DistortionFactors.x
  //   Uncloak：curveSet.scale = −1，从 min(已隐形时长, 6) 倒着放；6 秒后 Stop（clipSphereFactor = 0、activationStrength = 1、移除叠加层）
  // 溶解（EveSpaceObject2.PrepareShaderData）：球心 = 随机一个 damage 定位点 + 包围球心；Rn = 包围球半径 + |定位点|，
  //   半径 = clipSphereFactor × Rn × (1 + min(1, |定位点| / Rn))，传给着色器的是带符号的半径²。
  //   船体（quadv5）丢掉球内的像素；叠加层（fxcloakv5 / fxcloakdistortionv5）丢掉球外的像素（只在溶掉的部分画）。
  // 层：transparentEffects 3 层 fxtransitionv5（溶解边缘的噪声亮带，Alpha 混合，不裁剪）；
  //   additiveEffects 2 层 fxcloakv5（CloakWaves_widefresnel 噪声波纹 + CloakColor 菲涅尔底色）；distortionEffects 1 层 fxcloakdistortionv5（屏幕空间六边形折射）。
  //   别人的船：cloaking.py Prepare 里删掉 additive / distortion（只剩溶解 + 边缘亮带，溶完就完全看不见）；自己的船全保留。
  const CK_FRES = [[0, 0.35, 0, 0.0091782, 2], [3.00966, 1.3, -0.027964, -0.0281446, 2], [6, 0.35, -0.0118492, 0, 2]];
  const ckLin = (a) => a.map(([t, v]) => [t, v, 0, 0, 1]);
  // 变体（.black 之间只差这些常量）：hex = DistortionMap，hx = HexFactors.x，dhy = 扭曲层 HexFactors.y，cal = Calibration 曲线，
  //   wf / wc = CloakWaves 的 FresnelFactors / FxColor（三角 / 五边形版没写 FresnelFactors，用着色器默认值 (1, 1, 0, 0)），
  //   cf = CloakColor 的 FresnelFactors.x / .z，bt = NoiseTransition_BrightAndTight 的 FxColor
  const CK_VAR = {
    '': { hex: 'hexes_128', hx: 80, dhy: 0.66, cal: ckLin([[0, 0.1], [4.5, 0.1], [5, -0.1], [59, -0.1], [60, 0.1]]), wf: [16, 0.36462, 0.25], wc: [0.42745, 0.46275, 0.48235], cf: [0.1, 0], bt: [1.62353, 2.98824, 6] },
    p: { hex: 'pentagons_01', hx: 40, dhy: 1.25, cal: ckLin([[0, 0.22], [4.5, 0.22], [5, -0.25], [59, -0.25], [60, 0.2]]), wf: [1, 1, 0], wc: [0.42745, 0.46275, 0.47843], cf: [1, 0], bt: [6, 5.31765, 4.02353] },
    t: { hex: 'trilens_01', hx: 40, dhy: 0.66, cal: ckLin([[0, 0.175], [4.66, 0.175], [5, -0.242], [59, -0.242], [60, 0.175]]), wf: [1, 1, 0], wc: [0.42745, 0.46275, 0.47843], cf: [1, 0], bt: [1.57647, 5.52941, 6] },
  };
  const ckTexs = {};
  const ckTex = (n, mip = true, wrap = THREE.RepeatWrapping) => {
    if (!ckTexs[n]) {
      const tx = new THREE.TextureLoader().load(`${fxDir}cloak/${n}.png?v=1`);
      tx.flipY = false;   // 按 DirectX 的 uv（v 向下）采样
      tx.wrapS = tx.wrapT = wrap; tx.generateMipmaps = mip;
      tx.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
      ckTexs[n] = tx;
    }
    return ckTexs[n];
  };
  const ckVp = new THREE.Vector2(1, 1), ckTime = { value: 0 };
  const ckDist = new THREE.Scene();   // 扭曲层单独一个场景，后处理画进扭曲缓冲
  // 每个实例：ckC = 溶解球（模型空间，米）xyz + 带符号半径²；ckP = (FresnelTweaker, Calibration, 包围球半径 m, 是否自己的船)
  const CK_VS = `in vec4 ckC, ckP;
    out vec3 vP, vN, vV; out vec4 vC, vPar;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      mat4 im = modelMatrix * instanceMatrix;
      vec4 wp = im * vec4(position, 1.0);
      vP = position; vC = ckC; vPar = ckP;
      vN = mat3(im) * normal; vV = cameraPosition - wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`;
  const ckHead = () => `precision highp sampler3D;
    in vec3 vP, vN, vV; in vec4 vC, vPar;
    out vec4 outColor;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    ${SRGB_GLSL}
    // 屏幕 uv（DirectX：左上为原点）× HexFactors.x，横向再乘宽高比 × HexFactors.y
    vec2 hexUv(vec4 HX, vec2 vp) { vec2 s = vec2(gl_FragCoord.x / vp.x, 1.0 - gl_FragCoord.y / vp.y) * HX.x; s.x *= vp.x / vp.y * HX.y; return s; }`;
  const ckV4 = (a) => new THREE.Vector4(a[0], a[1], a[2] ?? 0, a[3] ?? 0);
  const ckMatCache = {};
  function ckMats(v) {
    if (ckMatCache[v]) return ckMatCache[v];
    const V = CK_VAR[v], hexMap = ckTex(V.hex);
    const base = { glslVersion: THREE.GLSL3, vertexShader: CK_VS, depthWrite: false };
    // fxtransitionv5（像素着色器反汇编）：3 次体积噪声 smoothstep 后按 0.3 / 0.5 / 0.2 相加 = N；
    //   u = saturate(N + (|p − 球心| − 半径) / (NoiseFactors.x × R × 0.1))；输出 FxColor，α = GradientMap(u).r × (半径 ≥ 0.001)
    //   客户端场景缓冲存 sRGB 编码值，这两种着色器结尾都不做线性 → sRGB，原样输出（之前多套了一层编码，0.13 变成 0.40，船发白）
    const trans = (col, nf) => new THREE.ShaderMaterial({ ...base,
      uniforms: { nz: { value: noise3 }, grad: { value: ckTex('gradient', false, THREE.ClampToEdgeWrapping) }, NF: { value: ckV4(nf) }, col: { value: new THREE.Vector3(...col) }, time: ckTime },
      fragmentShader: `${ckHead()}
        uniform sampler3D nz; uniform sampler2D grad; uniform vec4 NF; uniform vec3 col; uniform float time;
        float ss(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
        void main() {
          #include <logdepthbuf_fragment>
          float R = vPar.z, s = NF.y * R, ts = NF.w * time;
          float n = ss(texture(nz, (vP * 1.1113 + ts) / s).r) * 0.3 + ss(texture(nz, (vP * 0.5113 + ts) / s).r) * 0.5 + ss(texture(nz, (vP * 2.1113 + ts) / s).r) * 0.2;
          float rad = sqrt(abs(vC.w));
          float u = clamp(n + (length(vP - vC.xyz) - rad) / (NF.x * R * 0.1), 0.0, 1.0);
          outColor = vec4(col, texture(grad, vec2(u, 0.5)).r * step(0.001, rad));
        }`,
      transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    // fxcloakv5（像素着色器反汇编）：只画溶解球内；Layer1 uv = (|p − 球心|² / R², 噪声 × NoiseFactors.z + p.z / R) × Layer1Transform + 滚动，
    //   再加屏幕空间六边形偏移 × HexFactors.z + 0.5；颜色 = Layer1.r⁴ × FxColor + 菲涅尔 × (六边形.x × HexFactors.z + 0.5) × 0.2
    const add = (L) => new THREE.ShaderMaterial({ ...base,
      uniforms: { nz: { value: noise3 }, hexMap: { value: hexMap }, l1Map: { value: L.map ? ckTex(L.map) : whiteTex }, F: { value: ckV4(L.F) }, L1T: { value: ckV4(L.l1t) }, L1S: { value: ckV4(L.l1s) },
        HX: { value: ckV4([V.hx, 0.66, 0.05]) }, NF: { value: ckV4(L.nf) }, col: { value: new THREE.Vector3(...L.col) }, tweak: { value: L.tweak ? 1 : 0 }, vp: { value: ckVp }, time: ckTime },
      fragmentShader: `${ckHead()}
        uniform sampler3D nz; uniform sampler2D hexMap, l1Map; uniform vec4 F, L1T, L1S, HX, NF; uniform vec3 col; uniform float tweak, time; uniform vec2 vp;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 q = vP - vC.xyz; float d2 = dot(q, q);
          if (vPar.w < 0.5 || sign(vC.w) * d2 - vC.w > 0.0) discard;
          float R = vPar.z, n = texture(nz, vP / (NF.y * R)).r;
          vec2 uv = vec2(d2 / (R * R), n * NF.z + vP.z / R) * L1T.xy + L1T.zw + L1S.xy * time + L1S.zw;
          vec2 h = texture(hexMap, hexUv(HX, vp)).xy * 2.0 - 1.0;
          float l = texture(l1Map, uv + h * HX.z + 0.5).r; l *= l; l *= l;
          float fr = pow(1.0 - min(abs(dot(normalize(vV), normalize(vN)) - F.z), 1.0), F.x) * (tweak > 0.5 ? vPar.x : F.y);
          outColor = vec4(vec3(fr * (h.x * HX.z + 0.5) * 0.2) + l * col, 1.0);
        }`,
      transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    // fxcloakdistortionv5：只画溶解球内；输出 (六边形.xy × 2 − 1) × DistortionFactors.x + 0.5，b = 1/256，a = DistortionFactors.y。
    //   合成（postprocess/distortion）：偏移 uv = (rg − 0.5) × 2 × MAX_DISTORTION_OFFSET(默认 64) / 屏幕像素 → 这里直接写像素偏移（y 向下取反）
    const dist = new THREE.ShaderMaterial({ ...base,
      uniforms: { hexMap: { value: hexMap }, HX: { value: ckV4([V.hx, V.dhy]) }, dfy: { value: 0.125 }, vp: { value: ckVp } },
      fragmentShader: `${ckHead()}
        uniform sampler2D hexMap; uniform vec4 HX; uniform float dfy; uniform vec2 vp;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 q = vP - vC.xyz;
          if (vPar.w < 0.5 || sign(vC.w) * dot(q, q) - vC.w > 0.0) discard;
          vec2 o = (texture(hexMap, hexUv(HX, vp)).xy * 2.0 - 1.0) * vPar.y * 128.0;
          outColor = vec4(o.x, -o.y, 0.00390625, dfy);
        }`,
      depthTest: false, blending: THREE.NoBlending,
    });
    // 加色层：客户端是溶解球内所有正面都加上去（看得到船体内部结构，像玻璃）
    return (ckMatCache[v] = {
      tr: [trans([0.89725, 1.00431, 1.3], [1.333, 0.4, 0, 0]), trans([0.82824, 0.92706, 1.2], [0.5, 0.5, 1, 0]), trans(V.bt, [0.25, 0.666, 0, 0])],
      add: [
        add({ F: V.wf, l1t: [0.239277, 0.75, 0, 0], l1s: [-0.024, -0.027, 0.2333, -0.2333], col: V.wc, nf: [1.4466, 6.04442, 0.29914], map: 'noise_02' }),
        add({ F: [V.cf[0], 0, V.cf[1]], l1t: [1, 1, 0, 0], l1s: [0, 0, 0, 0], col: [0.011765, 0.019608, 0.023529], nf: [1, 1, 1], tweak: true }),
      ],
      dist,
    });
  }
  // 溶解中的船体：模型材质的副本，按实例的溶解球丢掉球内像素（quadv5：sign(r²)·|p − 球心|² − r² < 0 → discard），光照不动
  function ckHullMat(src) {
    const mm = src.clone();
    mm.defines = { ...src.defines };   // clone 只复制 STANDARD，推进器区的 EVE_HEAT 要带上
    mm.onBeforeCompile = (sh, r) => {
      src.onBeforeCompile(sh, r);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 ckC; varying vec4 vCkC; varying vec3 vCkP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCkP = position; vCkC = ckC;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vCkC; varying vec3 vCkP;')
        .replace('void main() {', 'void main() {\n{ vec3 ckQ = vCkP - vCkC.xyz; if (sign(vCkC.w) * dot(ckQ, ckQ) - vCkC.w < 0.0) discard; }');
    };
    mm.customProgramCacheKey = () => src.customProgramCacheKey() + '-ck';
    return mm;
  }
  // 一个模型一个变体一套：共用几何的顶点数据 + 自己的实例属性；船体、3 层过渡、2 层加色在主场景，扭曲层在 ckDist
  function ckBundle(m, v) {
    m.ck ||= {};
    if (m.ck[v]) return m.ck[v];
    const src = m.def.geometry, g = new THREE.BufferGeometry(), cap = Math.max(1, m.units.length);
    for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
    g.setIndex(src.index);
    for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    for (const k of ['ckC', 'ckP']) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const M = ckMats(v);
    m.ckHull ||= m.def.materials.map(ckHullMat);
    const mk = (mat, order, sc = scene) => {
      const o = new THREE.InstancedMesh(g, mat, cap);
      o.instanceMatrix.setUsage(THREE.DynamicDrawUsage); o.frustumCulled = false; o.renderOrder = order; o.count = 0;
      sc.add(o);
      return o;
    };
    const b = { g, cap, n: 0, meshes: [mk(m.ckHull, 0), ...M.tr.map((x, k) => mk(x, 2 + k)), ...M.add.map((x, k) => mk(x, 6 + k)), mk(M.dist, 0, ckDist)] };
    for (let k = 0; k < cap; k++) b.meshes[0].setColorAt(k, new THREE.Color(1, 1, 1));
    return (m.ck[v] = b);
  }
  function ckDrop(m) {
    for (const b of Object.values(m.ck || {})) { for (const o of b.meshes) { o.parent?.remove(o); o.dispose(); } b.g.dispose(); }
    m.ck = null;
    for (const x of m.ckHull || []) x.dispose();
    m.ckHull = null;
  }
  // 一艘溶解中的船加进本模型的隐形实例
  const ckCen = [0, 0, 0];
  function ckPush(m, ck, mat) {
    const b = ckBundle(m, ck.v), def = m.def, k = b.n++;
    if (k >= b.cap) { b.n--; return; }
    const D = def.loc?.damage, L = D?.length ? D[ck.seed % D.length] : [0, 0, 0], c = def.c || [0, 0, 0], R = def.r || 50;
    const lo = Math.hypot(L[0], L[1], L[2]), Rn = R + lo, rad = ck.f * Rn * (1 + Math.min(1, lo / Rn));
    for (let q = 0; q < 3; q++) ckCen[q] = L[q] + c[q];
    b.g.attributes.ckC.array.set([ckCen[0], ckCen[1], ckCen[2], rad * rad], k * 4);
    b.g.attributes.ckP.array.set([ck.fy, ck.cal, R, ck.self ? 1 : 0], k * 4);
    for (const o of b.meshes) o.setMatrixAt(k, mat);
  }
  function ckFlush(m) {
    for (const b of Object.values(m.ck || {})) {
      for (const o of b.meshes) { o.count = b.n; o.visible = b.n > 0; o.instanceMatrix.needsUpdate = true; }
      if (b.meshes[0].instanceColor) b.meshes[0].instanceColor.needsUpdate = true;
      b.g.attributes.ckC.needsUpdate = b.g.attributes.ckP.needsUpdate = true;
      b.n = 0;
    }
  }
  // 别人跃迁时船模型藏起来（WarpFlashOut 起跳闪光时隐藏，WarpFlashIn 落地闪光时再出现；短于 4 万 km 的跃迁不藏）
  let warpEv = null, warpEvN = -1, warpEvR = null;
  function warpHidden(i, t) {
    const ev = rec.events || [];
    if (warpEvR !== rec || warpEvN !== ev.length) { warpEvR = rec; warpEvN = ev.length; warpEv = ev.filter((e) => e.kind === 'warp' && e.tOut != null && e.D >= 4e7); }
    if (!warpEv.length || i === (hooks.self?.() ?? -1)) return false;
    for (const e of warpEv) if (e.unit === i && t >= e.tOut && t < e.tIn) return true;
    return false;
  }
  // 隐形装置连续开着的帧区间（往回找起点；按船缓存，避免每帧从头扫）
  const ckRun = [];
  function runStart(i, bitm, k) {
    const F = rec.frames, c = ckRun[i]?.rec === rec && ckRun[i].bit === bitm ? ckRun[i] : null;
    if (c && k >= c.s && k <= c.e) return c.s;
    let b = k;
    while (b > 0 && F[b - 1].act?.[i] & bitm) {
      if (c && b - 1 >= c.s && b - 1 <= c.e) { b = c.s; break; }
      b--;
    }
    ckRun[i] = { rec, bit: bitm, s: b, e: c && c.s === b ? Math.max(c.e, k) : k };
    return b;
  }
  // 曲线求值，最后一键之后循环（Tr2CurveExtrapolation.CYCLE），第一键之前保持
  function curveCyc(K, a) {
    const t0 = K[0][0], len = K[K.length - 1][0] - t0;
    return curveAt(K, a > t0 + len ? t0 + ((a - t0) % len) : a);
  }
  // 第 i 艘船的隐形状态：{ f = clipSphereFactor, act = activationStrength, fy = FresnelTweaker, cal = Calibration, self, v = 变体, seed = 选定位点用 }；
  //   没开 / 解除隐形已播完 → null
  function cloakAt(i, t) {
    const rack = rec.units[i].rack || [];
    const j = rack.findIndex((x) => x.hfx === 'ck');
    if (j < 0 || j >= 32) return null;
    const F = rec.frames, dt = rec.dt, k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt))), bitm = 1 << j;
    let a, s;
    if (F[k].act?.[i] & bitm) {
      s = runStart(i, bitm, k);
      a = t - (F[s].t - dt);
    } else {
      let b = 0;
      const n = Math.ceil(6 / dt) + 1;
      while (b < n && F[k - b] && !(F[k - b].act?.[i] & bitm)) b++;
      if (b >= n || !F[k - b]) return null;
      const ko = k - b, since = t - F[ko].t;
      if (since >= 6) return null;
      s = runStart(i, bitm, ko);
      a = Math.min(F[ko].t - (F[s].t - dt), 6) - since;   // Uncloak：PlayFrom(min(已播时长, 6))，scale = −1
    }
    const v = CK_VAR[rack[j].ckv] ? rack[j].ckv : '';
    return { f: 1.13 * Math.min(1, Math.max(0, a / 4.9)), act: Math.min(1, Math.max(0, 1 - a / 6)), fy: curveCyc(CK_FRES, a), cal: curveCyc(CK_VAR[v].cal, a),
      self: i === (hooks.self?.() ?? -1), v, seed: (Math.imul(s + 1, 2654435761) ^ Math.imul(i + 7, 40503)) >>> 0 };
  }
  // 曲线求值：[时间, 值, 左切线, 右切线, 插值]；插值 1 = 线性，2 = Hermite（用前一键的右切线、后一键的左切线）
  function curveAt(K, t) {
    if (t <= K[0][0]) return K[0][1];
    let j = 1;
    while (j < K.length - 1 && K[j][0] < t) j++;
    const a = K[j - 1], b = K[j], d = Math.max(1e-6, b[0] - a[0]), f = Math.min(1, (t - a[0]) / d);
    if (a[4] !== 2) return a[1] + (b[1] - a[1]) * f;
    const f2 = f * f, f3 = f2 * f;
    return (2 * f3 - 3 * f2 + 1) * a[1] + (f3 - 2 * f2 + f) * d * a[3] + (-2 * f3 + 3 * f2) * b[1] + (f3 - f2) * d * b[2];
  }
  // 体积噪声 3dfx_voronoi_02a（128³ DXT5 → 64³，竖排切片 voronoi3d.png）
  const vor3 = new THREE.Data3DTexture(new Uint8Array(64 * 64 * 64 * 4).fill(64), 64, 64, 64);
  vor3.format = THREE.RGBAFormat; vor3.magFilter = THREE.LinearFilter; vor3.minFilter = THREE.LinearMipmapLinearFilter; vor3.generateMipmaps = true;
  vor3.wrapS = vor3.wrapT = vor3.wrapR = THREE.RepeatWrapping; vor3.needsUpdate = true;
  let vorAsked = false;
  function vorLoad() {
    if (vorAsked) return;
    vorAsked = true;
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 4096;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      vor3.image.data.set(g.getImageData(0, 0, 64, 4096).data); vor3.needsUpdate = true;
    };
    im.src = `${opt.fx || 'assets/eveui/fx/'}hull/voronoi3d.png?v=1`;
  }
  // 模型空间坐标：客户端蒙皮版直接用船的米制局部坐标采样（不归一化，大船上纹理就是更密）；这里按模型包围球归一化到 [-1, 1]，是近似
  function fx3dMat(P, def) {
    vorLoad();
    const mk = new THREE.Vector4(...P.base), fk = new THREE.Vector4(...P.fx);
    const mt = hullTex(P.mask);
    return new THREE.ShaderMaterial({
      uniforms: { vol: { value: vor3 }, tm: { value: mt }, F: { value: new THREE.Vector3(...P.F) },
        l1t: { value: new THREE.Vector4(...P.l1t) }, l1s: { value: new THREE.Vector4(...P.l1s) }, l2t: { value: new THREE.Vector4(...P.l2t) }, l2s: { value: new THREE.Vector4(...P.l2s) },
        l3t: { value: new THREE.Vector4(...P.l3t) }, l3s: { value: new THREE.Vector4(...P.l3s) }, uvw: { value: new THREE.Vector2(P.l1w, P.l2w) },
        base: { value: mk }, fxc: { value: fk }, time: { value: 0 }, oc: { value: new THREE.Vector3(...(def?.c || [0, 0, 0])) }, orr: { value: 1 / Math.max(1, def?.r || 1) } },
      vertexShader: `uniform vec3 oc; uniform float orr; varying vec3 vP, vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          mat4 im = modelMatrix * instanceMatrix;
          vec4 wp = im * vec4(position, 1.0);
          vN = mat3(im) * normal; vV = normalize(cameraPosition - wp.xyz); vP = (position - oc) * orr;
          vCol = vec3(0.0);
          #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
          #endif
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      // vCol.x = 亮度曲线，vCol.y = UvOffset 曲线
      fragmentShader: `precision highp sampler3D; uniform sampler3D vol; uniform sampler2D tm; uniform vec3 F; uniform vec4 l1t, l1s, l2t, l2s, l3t, l3s, base, fxc; uniform vec2 uvw; uniform float time;
        varying vec3 vP, vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float fy = F.y * vCol.x;
          float d = clamp(dot(vV, normalize(vN)) - F.z, 0.0, 1.0);
          float x = pow(1.0 - d, F.x);
          float fres = fy < 0.0 ? (1.0 - min(x, 1.0)) * -fy : x * fy;
          vec3 o1 = vec3(l1s.yz, l1s.w + uvw.x * vCol.y), o2 = vec3(l2s.yz, l2s.w + uvw.y * vCol.y);
          float n = texture(vol, fract(l1s.x * time) + o1 + vP * l1t.x + l1t.yzw).x * texture(vol, fract(l2s.x * time) + o2 + vP * l2t.x + l2t.yzw).y;
          vec4 m = texture2D(tm, length(vP) * l3t.xy + l3t.zw + fract(l3s.xy * time) + l3s.zw);
          gl_FragColor = vec4(fres * (n * m.rgb * fxc.rgb + m.a * base.rgb), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }
  const hfxTex = {};
  const hullTex = (n) => {
    if (!n) return null;
    if (!hfxTex[n]) {
      const tx = new THREE.TextureLoader().load(`${opt.fx || 'assets/eveui/fx/'}hull/${n}.png?v=1`);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      hfxTex[n] = tx;
    }
    return hfxTex[n];
  };
  const hfxMats = {};
  const whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); whiteTex.needsUpdate = true;
  function hfxMat(kind, def) {
    if (hfxMats[kind]) return hfxMats[kind];
    const [, base, pass] = /^(\w+?)(?:#(\d))?$/.exec(kind);
    if (HFX[base]?.passes) return fx3dMat(HFX[base].passes[+pass || 0], def);
    const h = HFX[kind];
    return (hfxMats[kind] = new THREE.ShaderMaterial({
      uniforms: { t1: { value: hullTex(h.l1) }, t2: { value: hullTex(h.l2) }, tm: { value: hullTex(h.mask) || whiteTex },
        l1t: { value: new THREE.Vector4(...h.t1) }, l1s: { value: new THREE.Vector4(...h.s1) }, l2t: { value: new THREE.Vector4(...h.t2) }, l2s: { value: new THREE.Vector4(...h.s2) },
        F: { value: new THREE.Vector3(...h.F) }, time: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying vec3 vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          mat4 im = modelMatrix * instanceMatrix;
          vec4 wp = im * vec4(position, 1.0);
          vN = mat3(im) * normal; vV = normalize(cameraPosition - wp.xyz); vUv = uv;
          vCol = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
          #endif
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `uniform sampler2D t1, t2, tm; uniform vec4 l1t, l1s, l2t, l2s; uniform vec3 F; uniform float time; varying vec2 vUv; varying vec3 vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${SRGB_GLSL}
        void main() {
          #include <logdepthbuf_fragment>
          float d = clamp(dot(vV, normalize(vN)) - F.z, 0.0, 1.0);
          float x = pow(1.0 - d, F.x);
          float fres = F.y < 0.0 ? (1.0 - min(x, 1.0)) * -F.y : x * F.y;
          vec3 a = texture2D(t1, vUv * l1t.xy + l1t.zw + l1s.xy * time + l1s.zw).rgb * texture2D(t2, vUv * l2t.xy + l2t.zw + l2s.xy * time + l2s.zw).rgb * texture2D(tm, vUv).rgb;
          gl_FragColor = vec4(fres * a * vCol, 1.0);   // 原版不做 sRGB 转换，直接写进场景缓冲
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  }
  const hfxColor = new THREE.Color();
  function hfxCurve(h, age) {
    const K = h.keys;
    if (age <= 0 || age >= h.len) return null;
    let j = 1;
    while (j < K.length - 1 && K[j][0] < age) j++;
    const [t0, c0] = K[j - 1], [t1, c1] = K[j], f = (age - t0) / Math.max(1e-6, t1 - t0);
    return hfxColor.setRGB(c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f).multiplyScalar(h.gain);
  }
  // 第 i 艘船第 m 件装备：维修类 = 离最近一次周期开始（fire 位）过了多久；抗性类 = 连续开着多久（按曲线长度循环，对应客户端每周期 Repeat 重播）
  function hfxAge(i, m, t, h) {
    const F = rec.frames, dt = rec.dt, k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt))), bitm = 1 << m;
    if (!(F[k].act?.[i] & bitm)) return -1;   // 关掉就移除（ShipRenderEffect.Stop）
    if (h.loop) {
      let b = 0;
      while (b < 200 && F[k - b - 1] && F[k - b - 1].act?.[i] & bitm) b++;
      return (t - (F[k - b].t - dt)) % h.len;
    }
    for (let b = 0; b <= Math.ceil(h.len / dt) + 1; b++) {
      const fr = F[k - b];
      if (!fr) break;
      if (fr.fire?.[i] & bitm) return t - (fr.t - dt);
    }
    return -1;
  }
  function build(m) {
    if (m.hfx) for (const x of Object.values(m.hfx)) { scene.remove(x); x.dispose(); if (!Object.values(hfxMats).includes(x.material)) x.material.dispose(); }
    m.hfx = {};
    ckDrop(m);
    if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); }
    m.mesh = new THREE.InstancedMesh(m.def.geometry, m.def.materials, m.units.length);
    m.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    shAttr(m.mesh, m.units.length);
    m.mesh.frustumCulled = false;
    m.mesh.castShadow = m.mesh.receiveShadow = true; m.mesh.layers.enable(SSAO_LAYER);
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
  // 喷口火焰：照客户端着色器 booster/boostervolumetric（ps_5_0 反汇编）翻的体积光线步进。
  // 每个喷口一个盒子（x、y ∈ ±1，z ∈ −1…0，喷口在 z = 0），盒子的缩放 = SOF 喷口 transform（x/y = 口径，z = 长度 ×(0.5 + 0.5×强度)）。
  // 射线穿过盒子最多走 12 步；每一步：3D 噪声扰动采样点（振幅从 NoiseAmplitudeStart 过渡到 End）→ 渐变贴图（u = 沿长度，v 按强度选行；
  // A = 这一段的截面半径，RGB = 亮度）→ 形状图集（按 atlasIndex 选格子，xy ÷ 截面半径）→ 累加 渐变 × 形状 × Color0。最后线性转 sRGB。
  const fxDir = opt.fx || 'assets/eveui/fx/';
  const rawTex = (name, mip = false) => {
    const tx = new THREE.TextureLoader().load(`${fxDir}${name}?v=1`);
    tx.flipY = false; tx.generateMipmaps = mip;
    tx.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
    return tx;
  };
  const gradTex = rawTex('booster.png'), shapeTex = rawTex('booster-shape.png', true), sharpTex = rawTex('whitesharp.png', true);
  const noise2Tex = rawTex('noise2d.png'); noise2Tex.wrapS = noise2Tex.wrapT = THREE.RepeatWrapping;
  // 3D 噪声（noise32cube_volume：32³ RGB）：切片图 32×1024 拼回 3D 贴图
  const noise3 = new THREE.Data3DTexture(new Uint8Array(32 * 32 * 32 * 4).fill(128), 32, 32, 32);
  noise3.format = THREE.RGBAFormat; noise3.minFilter = noise3.magFilter = THREE.LinearFilter;
  noise3.wrapS = noise3.wrapT = noise3.wrapR = THREE.RepeatWrapping; noise3.needsUpdate = true;
  {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 1024;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      noise3.image.data.set(g.getImageData(0, 0, 32, 1024).data); noise3.needsUpdate = true;
    };
    im.src = `${fxDir}noise32.png?v=1`;
  }
  const SRGB_GLSL = `vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.003131)))); }`;
  const flameGeo = new THREE.InstancedBufferGeometry();
  {
    const b = new THREE.BoxGeometry(2, 2, 1); b.translate(0, 0, -0.5);
    flameGeo.setAttribute('position', b.attributes.position); flameGeo.setIndex(b.index);
  }
  let flameCap = 0;
  // 每个实例：矩阵 4 列、噪声振幅起 / 止、噪声频率（w = 时间系数）、颜色、(种子, 图集格, 强度)
  const FLAME_ATTR = [['iM0', 4], ['iM1', 4], ['iM2', 4], ['iM3', 4], ['iA0', 3], ['iA1', 3], ['iFq', 4], ['iCol', 3], ['iMisc', 3]];
  const flameMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { grad: { value: gradTex }, shape: { value: shapeTex }, noise: { value: noise3 }, time: { value: 0 } },
    vertexShader: `in vec4 iM0, iM1, iM2, iM3; in vec3 iA0, iA1, iCol, iMisc; in vec4 iFq;
      out vec3 vPos, vCam, vA0, vA1, vCol, vMisc, vScale; out vec4 vFq;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        mat4 m = mat4(iM0, iM1, iM2, iM3);
        vPos = position; vCam = (inverse(m) * vec4(cameraPosition, 1.0)).xyz;
        vA0 = iA0; vA1 = iA1; vCol = iCol; vMisc = iMisc; vFq = iFq;
        gl_Position = iMisc.z <= 0.0001 ? vec4(0.0) : projectionMatrix * viewMatrix * m * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `precision highp sampler3D;
      uniform sampler2D grad, shape; uniform sampler3D noise; uniform float time;
      in vec3 vPos, vCam, vA0, vA1, vCol, vMisc; in vec4 vFq;
      out vec4 outColor;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${SRGB_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        // 画的是盒子背面：这里是射线穿出点；穿入点用射线和盒子求交（镜头在盒子里时从镜头处开始）
        vec3 rd = vPos - vCam, inv = 1.0 / rd;
        vec3 ta = (vec3(-1.0, -1.0, -1.0) - vCam) * inv, tb = (vec3(1.0, 1.0, 0.0) - vCam) * inv, tn = min(ta, tb);
        float tE = max(max(tn.x, tn.y), max(tn.z, 0.0));
        vec3 pe = vCam + rd * tE, d = vPos - pe;
        if (dot(d, d) < 0.00001) discard;
        int n = max(2, int(min(1.0, length(d * vec3(1.0, 1.0, 2.0))) * 12.0));
        vec3 st = d / float(n - 1), p = pe;
        float I = vMisc.z;
        float tN = vFq.w * time + vMisc.x;
        float gv = (clamp(I * 0.5, 0.0, 1.0) * 0.375 + 0.0625) * 0.5;          // 渐变图上半张 = GradientMap0 的 8 行
        float cell = 31.0 / 256.0, off = vMisc.y / 8.0 + 0.5 / 256.0;           // 形状图集：256 高、8 格
        vec4 acc = vec4(0.0);
        for (int k = 0; k < 12; k++) {
          if (k >= n) break;
          vec3 nc = p * vFq.xyz;
          vec3 nz = texture(noise, vec3(nc.xy, nc.z * p.z * p.z + tN)).xyz - 0.5;
          vec3 q = p + nz * (vA0 - p.z * (vA1 - vA0));
          vec4 g = texture(grad, vec2(-q.z, gv));
          if (g.a > 0.0 && (g.r > 0.0 || g.g > 0.0 || g.b > 0.0)) {
            vec2 uv = q.xy / g.a * 0.5 + 0.5;
            if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) acc += g * textureLod(shape, vec2(uv.x, uv.y * cell + off), 0.1 / g.a / g.a) * vec4(vCol, 0.0);
          }
          p += st;
        }
        float f = clamp((I - 0.01) * 50.0, 0.0, 1.0);
        acc *= length(d) * 0.666667 / float(n) * f * f * (3.0 - 2.0 * f);
        outColor = vec4(toSrgb(acc.rgb), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });
  const flames = new THREE.Mesh(flameGeo, flameMat);
  flames.frustumCulled = false;
  scene.add(flames);
  // 喷口光点：着色器 booster/boosterglowanimated —— 朝向镜头的矩形贴图（whitesharp），颜色 ×4、噪声闪烁 0.8–1.0、线性转 sRGB。
  // 每个喷口 3 张（glow、对称光晕、横向光晕；尺寸 = 口径 × glowScale / symHaloScale / haloScaleX·Y）—— 张数和尺寸是引擎 C++ 定的，这里按 CCP 公开的 ccpwgl 库的做法
  const glowGeo = new THREE.InstancedBufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  glowGeo.setIndex([0, 1, 2, 0, 2, 3]);
  let glowCap = 0;
  const GLOW_ATTR = [['iPos', 3], ['iSize', 3], ['iCol', 3]];   // iSize = 宽、高、闪烁相位
  const glowMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { map: { value: sharpTex }, nz: { value: noise2Tex }, time: { value: 0 } },
    vertexShader: `in vec3 iPos, iSize, iCol; uniform sampler2D nz; uniform float time; out vec2 vUv; out vec3 vCol;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        mv.xy += position.xy * iSize.xy;
        vUv = position.xy + 0.5;
        vCol = iCol * (texture(nz, vec2(time * 0.5 + iSize.z, 0.0)).r * 0.2 + 0.8);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform sampler2D map; in vec2 vUv; in vec3 vCol; out vec4 outColor;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${SRGB_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        outColor = vec4(toSrgb(texture(map, vUv).rgb * vCol * 4.0), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const glows = new THREE.Mesh(glowGeo, glowMat);
  glows.frustumCulled = false;
  scene.add(glows);
  // 没有喷口参数的模型（旧数据）用的默认值
  const BST_DEF = { c0: [10.6, 13.2, 15], a0: [-0.06, -0.06, -0.06], a1: [0.19, 0.19, 0.19], fq: [0.18, 0.18, -0.006, 0.1], glow: [10, 0.004, 0.008, 0.016], halo: [35, 2, 0.008, 0.02, 0.035], sym: 10 };
  const mBst = new THREE.Matrix4(), mBst2 = new THREE.Matrix4();

  // 诱导进场的闪光（世界空间大小随距离缩放，与尾焰同一套着色器）
  const flashGeo = new THREE.BufferGeometry();
  flashGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
  flashGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 16), 3));
  flashGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(16), 1));
  const flash = new THREE.Points(flashGeo, bstMat);
  flash.frustumCulled = false;
  scene.add(flash);
  // 拦截泡（引擎事件 kind 'bubble'：位置、半径、持续时间）
  // 照客户端特效 fisfx/generic/warp_disruption/warp_disruption_probe.black（拦截泡探针 22778 的 graphicID 3018）重写：
  //   球体（客户端 sphere4k.gr2，这里用 three 的球）+ 着色器 warpdisruptionbubble.fx（按 dx11 反汇编逐条翻译）
  //   材质参数：Color (0.998, 1.428, 2.839, 1.67)、BrightnessParams (随机 24–42, 86, 0.333, 0)、Fresnel (反射, 18, 边缘, 粗糙 0.1)、
  //            LayerParams 用着色器默认 (100, 100, 0.3, 50)，MaskMap = lightningwcaustics_01a
  //   曲线 play_start：Bubble_Scaler 0 → 0.3 s 500 → 2 s 5500 → 3.5 s 6450 → 7 s 6500（÷ 6500 = 展开比例）；
  //            EdgeFadeIn → Fresnel.z（× 0.42）、ReflectionFadeIn → Fresnel.x（× 1.334）；
  //            LayerOffsets = (随机 0–0.5 + TextureScaler) × (−1.0005, 0.84225, 0.6855)；800 秒转一圈；柏林噪声轻微抖动
  //   特效按 20 km 半径做的，客户端按实际半径缩放；球网格半径 = 20000 / 2047500（最终缩放）
  // 没做的：粒子闪光（Particle_Flare 刚展开时的一下）、Bubble_Color 颜色曲线（不确定怎么套，用材质里存的固定颜色）
  const BUB_R0 = 20000 / 2047500;
  const crv = (k, t) => { if (t <= k[0][0]) return k[0][1]; for (let i = 1; i < k.length; i++) if (t <= k[i][0]) { const [t0, v0] = k[i - 1], [t1, v1] = k[i], u = (t - t0) / (t1 - t0), h = u * u * (3 - 2 * u); return v0 + (v1 - v0) * h; } return k[k.length - 1][1]; };
  const BUB_SCALE = [[0, 0], [0.3, 500], [2, 5500], [3.5, 6450], [7, 6500]];
  const BUB_EDGE = [[0, 0], [1.567, 0.487], [7, 1]], BUB_REFL = [[0, 0], [0.857, 0.501], [2.578, 1]], BUB_TEX = [[0, 0.1], [3.229, 0.946], [7, 1]];
  const bubTex = new THREE.TextureLoader().load(`${fxDir}cfx/tex/lightningwcaustics_01a.png?v=1`);
  bubTex.wrapS = bubTex.wrapT = THREE.RepeatWrapping;
  bubTex.colorSpace = THREE.NoColorSpace;
  const bubbleMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.NormalBlending,
    uniforms: {
      MaskMap: { value: bubTex }, Env: { value: null }, hasEnv: { value: 0 }, envI: { value: 1 },
      LayerOffsets: { value: new THREE.Vector4() }, LayerParams: { value: new THREE.Vector4(100, 100, 0.3, 50) },
      BrightnessParams: { value: new THREE.Vector4(30, 86, 0.333, 0) }, Color: { value: new THREE.Vector4(0.998, 1.428, 2.839, 1.67) },
      Fresnel: { value: new THREE.Vector4(0, 18, 0, 0.1) }, sunDir: { value: new THREE.Vector3(0, -1, 0) }, sunCol: { value: new THREE.Color(1, 1, 1) },
      r0: { value: BUB_R0 }, fade: { value: 1 },
    },
    vertexShader: `uniform float r0; varying vec3 vL; varying vec3 vNo; varying vec3 vNw; varying vec3 vW; varying float vD;
      void main() {
        vL = position * r0; vNo = normal;
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vNw = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * w; vD = -mv.z * 1000.0;   // 场景单位是 km，着色器里的距离按米
        gl_Position = projectionMatrix * mv;
      }`,
    // 逐条对应反汇编：三平面采样（每个平面两层 R、A 相乘再开方，按局部法线平方加权）、G 通道噪声、近处淡出、
    // 菲涅尔（x 反射、y 光照、z 边缘）、环境反射、太阳高光（背面直接加 1 = 透光）、× (1 − 边缘) × Color 截到 0–1、线性 → sRGB
    fragmentShader: `uniform sampler2D MaskMap; uniform samplerCube Env; uniform float hasEnv, envI, fade;
      uniform vec4 LayerOffsets, LayerParams, BrightnessParams, Color, Fresnel; uniform vec3 sunDir, sunCol;
      varying vec3 vL; varying vec3 vNo; varying vec3 vNw; varying vec3 vW; varying float vD;
      vec2 ra(vec2 uv) { vec4 t = texture2D(MaskMap, uv); return t.ra; }
      float s2l(float c) { return c < 0.04045 ? c * 0.0773994 : pow((c + 0.055) * 0.947867, 2.4); }
      vec3 l2s(vec3 c) { return mix(pow(c, vec3(0.416667)) * 1.055 - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.0031308)))); }
      void main() {
        float f = LayerParams.x; vec4 LO = LayerOffsets;
        vec2 xy = sqrt(ra(vL.xy * f + LO.yx) * ra(vL.xy * f + LO.zx));
        vec2 yz = sqrt(ra(vL.yz * f + LO.xy) * ra(vL.yz * f + LO.yz));
        vec2 xz = sqrt(ra(vL.xz * f + LO.yx) * ra(vL.xz * f + LO.zy));
        float fs = gl_FrontFacing ? -1.0 : 1.0;
        vec3 n = normalize(vNo) * fs, w = n * n;
        vec2 m = xy * w.z + yz * w.x + xz * w.y;
        float b = BrightnessParams.x;
        float nz = texture2D(MaskMap, vL.xz * b + 0.12).g * w.y + texture2D(MaskMap, vL.yz * b + 0.3).g * w.x + texture2D(MaskMap, vL.xy * b + 0.7).g * w.z;
        float a = s2l(m.y), c = nz * m.x * (gl_FrontFacing ? 1.0 : BrightnessParams.z);
        float near = pow(clamp(vD / LayerParams.y, 0.0, 1.0), LayerParams.z);
        float caus = mix(a, c, near) * BrightnessParams.y;
        float cA = clamp(vD / LayerParams.w, 0.0, 1.0) * caus;
        vec3 N = normalize(vNw) * fs, V = normalize(vW - cameraPosition);
        float d = dot(V, N);
        vec3 fr = pow(vec3(clamp(1.0 - d, 0.0, 1.0)), Fresnel.xyz);
        vec3 R = -(V - 2.0 * d * N);
        vec3 env = hasEnv > 0.5 ? textureCube(Env, R).rgb : vec3(0.015, 0.02, 0.03);
        env = pow(env, vec3(2.2)) * envI;
        vec3 col = env * fr.x + cA;
        vec3 L = normalize(sunDir);
        float nl = clamp(dot(L, N), 0.0, 1.0);
        vec3 H = normalize(L + V);
        float p = exp2((1.0 - Fresnel.w) * 10.0 + 1.0);
        float spec = gl_FrontFacing ? pow(clamp(dot(N, H), 0.0, 1.0), p) * (p + 1.0) * 0.5 : 0.0;
        float lt = ((gl_FrontFacing ? 0.0 : 1.0) + spec) * fr.y * nl;
        vec4 o = vec4(col + lt * sunCol, cA) * (1.0 - fr.z);
        o = clamp(o * Color, 0.0, 1.0);
        gl_FragColor = vec4(l2s(max(o.rgb, 0.0)), o.a * fade);
      }`,
  });
  let bubbleEnv = null;   // 场景反射立方体（天空换了就更新）
  const bubbleGeo = new THREE.SphereGeometry(1, 96, 48), bubbles = [];
  const bubRand = (e, k) => { const x = Math.sin((e.t * 97.13 + (e.pos?.[0] || 0) * 0.0131 + k * 13.7)) * 43758.5453; return x - Math.floor(x); };
  const perlin1 = (x) => { const i = Math.floor(x), f = x - i, g = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; }; const u = f * f * (3 - 2 * f); return (g(i) * f) * (1 - u) + (g(i + 1) * (f - 1)) * u; };
  function drawBubbles(t) {
    let c = 0;
    for (const e of rec.events || []) {
      if (e.kind !== 'bubble' || !e.pos) continue;
      const age = t - e.t;
      if (age < 0 || age > e.life || c >= 8) continue;
      const m = bubbles[c] || (bubbles[c] = Object.assign(new THREE.Mesh(bubbleGeo, bubbleMat.clone()), { frustumCulled: false, renderOrder: 5 }));
      if (!m.parent) scene.add(m);
      m.visible = true;
      m.position.set((e.pos[0] - ORG[0]) * KM, (e.pos[1] - ORG[1]) * KM, (e.pos[2] - ORG[2]) * KM);
      // 展开：Bubble_Scaler 曲线；抖动：柏林噪声（offset 1、scale 0.1、speed 0.1，每个轴不同相位）；800 秒绕 Y 转一圈
      const g = crv(BUB_SCALE, age) / 6500, R = Math.max(0.001, e.r * KM * g) / (BUB_R0 * 2047500 / 20000);
      m.scale.set(R * (1 + 0.1 * perlin1(age * 0.1 + 1.3)), R * (1 + 0.1 * perlin1(age * 0.1 + 7.1)), R * (1 + 0.1 * perlin1(age * 0.1 + 3.7)));
      m.rotation.y = (age / 800) * Math.PI * 2;
      const u = m.material.uniforms;
      const lo = bubRand(e, 1) * 0.5 + crv(BUB_TEX, age);
      u.LayerOffsets.value.set(lo * -1.0005, lo * 0.84225, lo * 0.6855, 0);
      u.BrightnessParams.value.x = 24 + bubRand(e, 2) * 18;
      u.Fresnel.value.set(crv(BUB_REFL, age) * 1.334, 18, crv(BUB_EDGE, age) * 0.42, 0.1);
      u.Env.value = bubbleEnv; u.hasEnv.value = bubbleEnv ? 1 : 0; u.envI.value = envI;
      u.sunDir.value.copy(sunDir).normalize().negate();   // 光照方向：从太阳照过来
      u.sunCol.value.copy(sun.color);
      u.fade.value = Math.min(1, (e.life - age) / 1);   // 最后 1 秒淡出（客户端回收时直接删掉）
      c++;
    }
    for (let k = c; k < bubbles.length; k++) bubbles[k].visible = false;
  }
  // 开火特效；P 是给特效模块的查询接口
  const fx = createFx(scene, renderer, { tex: opt.fx });
  let envFx = null;   // 深渊环境特效（sim-env.js）：第一次 setEnvFx 时才建
  const atV = [];
  // 每帧模型循环结束后把炮塔实例写进各自的 InstancedMesh
  const lastModel = () => { let l = null; for (const m of models.values()) if (m.state === 'ok' && m.mesh) l = m; return l; };
  function flushTurrets() {
    for (const tm of tModels.values()) {
      if (tm.state !== 'ok') continue;
      const n = tm.list.length;
      if (n > tm.cap) {
        tm.cap = Math.ceil(n * 1.5) + 4;
        if (tm.mesh) { scene.remove(tm.mesh); tm.mesh.dispose(); }
        tm.mesh = new THREE.InstancedMesh(tm.def.geometry, tm.def.materials, tm.cap);
        tm.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        shAttr(tm.mesh, tm.cap);
        tm.mesh.frustumCulled = false;
        tm.mesh.castShadow = tm.mesh.receiveShadow = true; tm.mesh.layers.enable(SSAO_LAYER);
        scene.add(tm.mesh);
      }
      if (!tm.mesh) continue;
      for (let c = 0; c < n; c++) tm.mesh.setMatrixAt(c, tm.list[c]);
      tm.mesh.count = n;
      tm.mesh.instanceMatrix.needsUpdate = true;
      tm.list.length = 0;
    }
  }
  const shT = new THREE.Object3D(), qI = new THREE.Quaternion();
  const P = {
    org: () => ORG,   // 浮动原点（米）：场景坐标 = (世界坐标 − ORG) / 1000
    self: () => hooks.self?.() ?? -1,   // 自己的船（有跃迁隧道，不播出 / 入跃迁闪光）
    mount: (i, ri, pick, out) => mountAt(i, ri, pick, out),
    get rec() { return rec; },
    get camera() { return camera; },
    at: (i) => atV[i] || null,
    posAt: (i, t, out) => posAt(i, t, out),
    radiusOf: (i) => radiusOf(i),
    extentOf: (i) => models.get(keyOf(i))?.def?.ext || null,   // 包围盒半轴（米）
    radiusM: (i) => shipIndex?.models?.[keyOf(i)]?.r || rec.units[i].radius || 50,
    get heading() { return heading; },
    shield: (i) => { const F = frameAt(lastDrawT); return i * 3 < F.hp.length && F.hp[i * 3] > 0 ? i + 1 : 0; },
    // 护盾椭球（模型的 se：船体坐标的中心、半轴，米）→ 世界矩阵（千米）
    shell: (i, out) => {
      const se = models.get(keyOf(i))?.def?.se, d = drawn[i];
      if (!se || !d) return null;
      shT.position.set(se[0], se[1], se[2]).applyQuaternion(heading[i] || qI).multiplyScalar(KM);
      shT.position.x += d.x; shT.position.y += d.y; shT.position.z += d.z;
      shT.quaternion.copy(heading[i] || qI);
      shT.scale.set(se[3] * KM, se[4] * KM, se[5] * KM);
      shT.updateMatrix();
      return out.copy(shT.matrix);
    },
  };
  // 悬停 / 选中 / 点名集火圈：屏幕空间的细圆（1 像素线宽），贴着总览图标
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 8), 3));
  ringGeo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(4 * 8), 4));
  ringGeo.setAttribute('rad', new THREE.BufferAttribute(new Float32Array(8), 1));
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { dpr: { value: dpr }, fade: brMat.uniforms.fade },
    vertexShader: `attribute vec4 tint; attribute float rad; varying vec4 vTint; varying float vR; uniform float dpr;
      void main() { vTint = tint; vR = rad * dpr; gl_PointSize = vR * 2.0 + 4.0 * dpr; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec4 vTint; varying float vR; uniform float dpr, fade;
      void main() { float d = length(gl_PointCoord - 0.5) * (vR * 2.0 + 4.0 * dpr); float a = (1.0 - smoothstep(0.35 * dpr, 0.9 * dpr, abs(d - vR))) * fade; if (a < 0.02) discard; gl_FragColor = vec4(vTint.rgb, vTint.a * a); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const ringPts = new THREE.Points(ringGeo, ringMat);
  ringPts.frustumCulled = false;
  ringPts.renderOrder = 6;
  scene.add(ringPts);
  let hover = -1, sel = -1, hoverC = -1, selC = -1;

  // 战术视图：照客户端 tacticalNavigation/tacticalCompass.py + res:/ui/inflight/tactical/*.black 的参数
  //   暗盘（黑 0.157，半径一半以外淡到 0）、距离圈（白，主圈 0.33 / 次圈 0.125，越靠外越淡）、16 条方位线（北向橙色）、
  //   锁定距离圈（红 0.5 / 1.0 相间的虚线）、悬停装备时的最佳 / 失准圈（红 0.66 / 0.33）和两层红色渐变；
  //   每艘船一条竖线连到盘面 + 落点锚标：青 0.3 / 有敌意红 0.5 / 当前目标白 0.5
  let tac = null;
  // 距离圈（千米）：按游戏录屏里看到的刻度（5 / 10 / 20 / 30 / 40 / 50 / 75 / 100 / 150 / 200 …）；
  // 客户端 _RANGES 反编译出来是 8..25 连号，和画面对不上，没用
  const TAC_RANGES = [5, 10, 20, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500];
  const TAC_MAJOR = new Set([50, 100, 200, 300, 500]);
  const TAC_N = TAC_RANGES.length;
  const tacMat = new THREE.ShaderMaterial({
    uniforms: { R: { value: 150 }, base: { value: 0 }, rings: { value: new Float32Array(TAC_N) }, ringA: { value: new Float32Array(TAC_N) }, lock: { value: 0 }, opt: { value: 0 }, fall: { value: 0 } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float R; varying vec2 vP;
      void main() { vP = position.xy * R; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float R; uniform float base; uniform float rings[${TAC_N}]; uniform float ringA[${TAC_N}]; uniform float lock; uniform float opt; uniform float fall; varying vec2 vP;
      float ln(float d, float fw) { return 1.0 - smoothstep(0.6 * fw, 1.6 * fw, abs(d)); }
      vec4 over(vec4 dst, vec3 c, float a) { a = clamp(a, 0.0, 1.0); return vec4(mix(dst.rgb, c, a / max(1e-4, a + dst.a * (1.0 - a))), a + dst.a * (1.0 - a)); }
      float ramp(float t, float a, float b) { return t <= a ? 0.0 : t < b ? (t - a) / (b - a) : t < 1.0 ? 1.0 - (t - b) / (1.0 - b) : 0.0; }
      void main() {
        #include <logdepthbuf_fragment>
        float r = length(vP), fw = max(fwidth(r), 1e-5), t = r / R;
        if (t > 1.0) discard;
        // 暗盘
        vec4 o = vec4(0.0, 0.0, 0.0, 0.157 * (t < 0.5 ? 1.0 : 1.0 - (t - 0.5) / 0.5));
        // 最佳 / 失准渐变（加色的红）
        vec3 red = vec3(1.0, 0.1, 0.025);
        if (opt > 0.0) {
          o = over(o, vec3(1.0, 0.0, 0.0), 0.078 * ramp(r / opt, 0.2, 0.4));
          if (fall > opt) o = over(o, vec3(1.0, 0.0, 0.0), 0.078 * ramp(r / (fall * 1.1), 0.6, 0.8));
        }
        // 距离圈
        float a = 0.0;
        for (int i = 0; i < ${TAC_N}; i++) a += ln(r - rings[i], fw) * ringA[i];
        o = over(o, vec3(1.0), a);
        // 方位线：每 22.5° 一条，离船 2 km 起淡入、5 km 处到位
        float ang = atan(-vP.y, vP.x), seg = PI / 8.0;
        float k = floor(ang / seg + 0.5), ad = (ang - k * seg) * r;
        float m = mod(k + 16.0, 4.0), q = mod(k + 16.0, 16.0);
        float la = m < 0.5 ? 0.05 : abs(m - 2.0) < 0.5 ? 0.025 : 0.015;
        vec3 lc = vec3(1.0);
        if (abs(q - 4.0) < 0.5) { la = 0.25; lc = vec3(0.9, 0.6, 0.2); }
        o = over(o, lc, ln(ad, fw) * la * smoothstep(base + 2.0, base + 5.0, r));
        // 锁定距离：红 0.5 / 1.0 相间（每四分之一圈 40 段）
        if (lock > 0.0) o = over(o, red, ln(r - lock, fw) * (fract(ang * 80.0 / PI) < 0.5 ? 0.5 : 1.0));
        if (opt > 0.0) {
          o = over(o, red, ln(r - opt, fw) * 0.66);
          if (fall > opt) o = over(o, red, ln(r - fall, fw) * 0.33);
        }
        if (o.a < 0.003) discard;
        gl_FragColor = o;
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const tacDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 128), tacMat);
  tacDisc.rotation.x = -Math.PI / 2;
  tacDisc.renderOrder = 1;
  tacDisc.frustumCulled = false;
  tacDisc.visible = false;
  scene.add(tacDisc);
  // 连线 / 锚标 / 速度箭头按客户端 tacticalOverlay 的三个着色器（connector / anchor / velocity）在标签层上画（都是加色混合、按屏幕像素算宽度）
  //   客户端贴图只用颜色通道：anchor.dds 的 R = 锁定距离内的样子、G = 距离外的暗样子；arrow_tactical.dds 的 RGB = 形状
  function chanTex(src, ch, done) {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d');
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height), a = d.data;
      for (let k = 0; k < a.length; k += 4) { const v = a[k + ch]; a[k] = a[k + 1] = a[k + 2] = 255; a[k + 3] = v; }
      g.putImageData(d, 0, 0);
      done(cv);
    };
    im.src = src;
  }
  function tintCv(cv, rgb) {
    const o = document.createElement('canvas');
    o.width = cv.width; o.height = cv.height;
    const g = o.getContext('2d');
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
    g.fillRect(0, 0, o.width, o.height);
    return o;
  }
  const tacTex = { anchorIn: null, anchorOut: null, arrow: [] };
  chanTex('assets/eveui/tactical/anchor.png?v=1', 0, (cv) => { tacTex.anchorIn = cv; });
  chanTex('assets/eveui/tactical/anchor.png?v=1', 1, (cv) => { tacTex.anchorOut = cv; });
  // 速度箭头三种颜色（velocityEffect DiffuseColor0 / 1 / 2）：0 = 速度方向（青），1 = 直冲我来的分量（红），2 = 距离变化率（白）
  const TAC_VCOL = [[0, 0.675, 0.9294, 0.3], [1, 0.0745, 0.0237, 0.5], [1, 1, 1, 0.4996]];
  chanTex('assets/eveui/tactical/arrow_tactical.png?v=1', 0, (cv) => { tacTex.arrow = TAC_VCOL.map((c) => tintCv(cv, c)); });
  let tacR = 0, tacBase = -1, tacLabelKm = [];
  function drawTac() {
    const c = tac && drawn[tac.center];
    tacDisc.visible = Boolean(c);
    if (!c) return;
    // 盘面范围（客户端 SetTargetingRange）：max(150 km, 锁定距离 × 1.1)，取到刚好盖过它的那一圈
    const base = radiusOf(tac.center), act = Math.max(150, (tac.lock || 0) * 1.1);
    let top = TAC_RANGES[TAC_N - 1];
    for (const r of TAC_RANGES) { top = r; if (r > act) break; }
    const R = top + base;
    if (R !== tacR || base !== tacBase) {
      tacR = R; tacBase = base; tacLabelKm = [];
      const rg = tacMat.uniforms.rings.value, ra = tacMat.uniforms.ringA.value;
      TAC_RANGES.forEach((r, i) => {
        const ar = r + base;
        if (ar > R) { rg[i] = -1e6; ra[i] = 0; return; }
        rg[i] = ar; ra[i] = (TAC_MAJOR.has(r) ? 0.33 : 0.125) * (0.75 * Math.pow((R - ar) / R, 0.4) + 0.25);
        tacLabelKm.push(r);
      });
    }
    tacDisc.position.set(c.x, c.y, c.z);
    tacDisc.scale.setScalar(R);
    const U = tacMat.uniforms;
    U.R.value = R; U.base.value = base;
    U.lock.value = tac.lock ? tac.lock + base : 0;
    U.opt.value = tac.opt ? tac.opt + base : 0;
    U.fall.value = tac.opt && tac.fall ? tac.opt + tac.fall + base : 0;
  }
  // ---- 每个物体的连线 / 锚标 / 速度箭头（客户端 tacticalOverlay.red 的 connector / anchor / velocity 三个着色器）----
  // 速度箭头长度 = 1 秒位移 × s，s = clamp(视深(米)^K × M, 1, 10)（距离变化率那种 clamp 到 5）；K、M 在常量缓冲里，反编译拿不到，这里是估的
  const ARW_K = 1, ARW_M = 0.00005;
  const tq = new THREE.Vector3();
  function tScr(x, y, z) { tq.set(x, y, z).project(camera); return tq.z > 1 || tq.z < -1 ? null : [(tq.x + 1) / 2 * lbl.width, (1 - tq.y) / 2 * lbl.height]; }
  function tDepth(x, y, z) { tq.set(x, y, z).applyMatrix4(camera.matrixWorldInverse); return Math.max(1e-6, -tq.z); }
  const tPxPerKm = (dep) => lbl.height / (2 * dep * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  function tVel(i, t) {
    const a = posAt(i, t, vA), b = posAt(i, t + rec.dt, vB);
    return a && b ? [(b.x - a.x) / rec.dt, (b.y - a.y) / rec.dt, (b.z - a.z) / rec.dt] : [0, 0, 0];
  }
  const arwScale = (d, hi) => Math.max(1, Math.min(hi, Math.pow(tDepth(d.x, d.y, d.z) * 1000, ARW_K) * ARW_M));
  // 线条：客户端连线横截面是三角形（中间最亮、两边淡到 0），这里叠三层近似
  function tStroke(pts, al, w) {
    if (pts.length < 2 || al <= 0.003) return;
    lctx.beginPath();
    lctx.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) lctx.lineTo(pts[k][0], pts[k][1]);
    for (const m of [1, 2 / 3, 1 / 3]) { lctx.lineWidth = w * m * dpr; lctx.strokeStyle = `rgba(255,255,255,${al / 3})`; lctx.stroke(); }
  }
  // 箭头：线宽 14 像素，贴图纵向 1 张 = 1 个线宽长，箭尖在终点，超过一张的部分取贴图最后一行（钳边）
  function tArrow(k, a, b, al) {
    const img = tacTex.arrow[k];
    if (!img || !a || !b || al <= 0.003) return;
    const W = 14 * dpr, dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    const f = k === 1 ? 1 : Math.max(0, Math.min(1, (L - W / 2) * 0.5 / dpr));   // 比半个线宽还短就淡掉
    if (L < 0.5 || f <= 0) return;
    lctx.save();
    lctx.translate(b[0], b[1]);
    lctx.rotate(Math.atan2(dx / L, -dy / L));
    lctx.globalAlpha = al * f;
    const hl = Math.min(L, W);
    lctx.drawImage(img, 0, 0, img.width, img.height * hl / W, -W / 2, 0, W, hl);
    if (L > W) lctx.drawImage(img, 0, img.height - 1, img.width, 1, -W / 2, W, W, L - W);
    lctx.restore();
  }
  function drawTacOverlay() {
    const c = tac && rec && drawn[tac.center];
    if (!c) return;
    const R = tacR, fade = Math.max((tac.lock || 0) * 0.25, 50);
    const pulse = 0.625 + 0.375 * Math.sin(performance.now() / 1000 * 8);
    const cv = tVel(tac.center, lastDrawT);
    lctx.save();
    lctx.globalCompositeOperation = 'lighter';
    // 选中的物体：一条从自己出发的淡直线（STYLE_FAINT，白 0.1）
    if (sel >= 0 && sel !== tac.center && drawn[sel]?.alive) {
      const a = tScr(c.x, c.y, c.z), b = tScr(drawn[sel].x, drawn[sel].y, drawn[sel].z);
      if (a && b) { lctx.beginPath(); lctx.moveTo(a[0], a[1]); lctx.lineTo(b[0], b[1]); lctx.lineWidth = 1.5 * dpr; lctx.strokeStyle = 'rgba(255,255,255,0.1)'; lctx.stroke(); }
    }
    drawn.forEach((d, i) => {
      if (!d?.alive) return;
      const ego = i === tac.center;
      const dx = d.x - c.x, dy = d.y - c.y, dz = d.z - c.z, dist = Math.hypot(dx, dy, dz), hd = Math.hypot(dx, dz);
      if (!ego && dist > R + fade) return;
      const f = ego ? 1 : 1 - Math.max(0, Math.min(1, (dist - R) / fade));
      const aggr = !ego && Boolean(tac.aggr?.(i));
      if (!ego && hd > 1e-6) {
        // 连线：以自己为球心、半径 = 直线距离的大圆弧，从物体一直落到盘面上同一方位；在盘面上方 0.3、下方 0.2
        const ux = dx / dist, uy = dy / dist, uz = dz / dist, ex = dx / hd, ez = dz / hd;
        const om = Math.acos(Math.max(-1, Math.min(1, ux * ex + uz * ez))), so = Math.sin(om);
        const N = Math.max(1, Math.ceil(om / 0.04)), pts = [];
        for (let k = 0; k <= N; k++) {
          const tt = k / N, s0 = om < 1e-4 ? 1 - tt : Math.sin((1 - tt) * om) / so, s1 = om < 1e-4 ? tt : Math.sin(tt * om) / so;
          const p = tScr(c.x + (ux * s0 + ex * s1) * dist, c.y + uy * s0 * dist, c.z + (uz * s0 + ez * s1) * dist);
          if (p) pts.push(p);
        }
        tStroke(pts, (d.y >= c.y ? 0.3 : 0.2) * f, 4);
        // 锚标：平躺在盘面上，大小 = 0.026 × 视深(米)^0.875；锁定距离内用贴图 R 通道、外面用 G 通道（暗）
        const ax = c.x + ex * dist, az = c.z + ez * dist, ap = tScr(ax, c.y, az), img = dist <= R ? tacTex.anchorIn : tacTex.anchorOut;
        if (ap && img) {
          const dep = tDepth(ax, c.y, az), px = 0.026 * Math.pow(dep * 1000, 0.875) / 1000 * tPxPerKm(dep);
          lctx.globalAlpha = f;
          lctx.drawImage(img, ap[0] - px / 2, ap[1] - px / 2, px, px);
          lctx.globalAlpha = 1;
        }
      }
      // 速度箭头
      const v = tVel(i, lastDrawT), sp = Math.hypot(v[0], v[1], v[2]) * 1000;
      if (sp < 0.5) return;
      const x = Math.max(0, Math.min(1, (sp - 40000) * 1.7e-5)), vf = (1 - (3 - 2 * x) * x * x) * f;   // 40 ~ 98.8 km/s 之间淡出（着色器常数 1.7e-5）
      const s = arwScale(d, 10), off = radiusOf(i), vn = sp / 1000;
      const sx = d.x + v[0] / vn * off, sy = d.y + v[1] / vn * off, sz = d.z + v[2] / vn * off;
      const col = (k) => TAC_VCOL[k][3] * vf * (aggr ? pulse : 1);
      tArrow(0, tScr(sx, sy, sz), tScr(sx + v[0] * s, sy + v[1] * s, sz + v[2] * s), col(0));
      if (ego || dist < 1e-6) return;
      const rx = dx / dist, ry = dy / dist, rz = dz / dist;
      // 红：直冲我来的那部分速度（速度方向和指向我的方向夹角余弦 > 0.65 才有），长度 × 2
      if (aggr) {
        const cs = Math.max(0, -(v[0] * rx + v[1] * ry + v[2] * rz) / vn), g = Math.max(0, Math.min(1, (cs - 0.65) * 2.898551));
        const k = (v[0] * rx + v[1] * ry + v[2] * rz) * g * s * 2;
        if (g > 0) tArrow(1, tScr(d.x, d.y, d.z), tScr(d.x + rx * k, d.y + ry * k, d.z + rz * k), col(1));
      }
      // 白：选中物体的距离变化率（1 秒后的距离 − 现在的距离），沿连线方向
      if (i === sel) {
        const nd = Math.hypot(d.x + v[0] - c.x - cv[0], d.y + v[1] - c.y - cv[1], d.z + v[2] - c.z - cv[2]);
        const k = (nd - dist) * arwScale(d, 5);
        tArrow(2, tScr(d.x, d.y, d.z), tScr(d.x + rx * k, d.y + ry * k, d.z + rz * k), col(2));
      }
    });
    lctx.restore();
  }
  // 距离圈上的千米数（每圈四个方位各一个）在屏幕上的位置，给界面层画字
  function tacLabels() {
    const c = tac && drawn[tac.center];
    if (!c) return [];
    const out = [], w = host.clientWidth, h = host.clientHeight;
    for (const r of tacLabelKm) {
      const d = r + tacBase;
      for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        vA.set(c.x + dx, c.y, c.z + dz).project(camera);
        if (vA.z > 1 || Math.abs(vA.x) > 1 || Math.abs(vA.y) > 1) continue;
        out.push([(vA.x + 1) / 2 * w, (1 - vA.y) / 2 * h, r]);
      }
    }
    return out;
  }
  // 画质档位：改像素比，按像素算大小的图标 / 圈一起改
  function applyLevel(l) {
    level = l;
    dpr = l === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    brMat.uniforms.size.value = iconPx * dpr;
    flMat.uniforms.size.value = 9 * dpr;
    ringMat.uniforms.dpr.value = dpr;
    sky.visible = l === 'high' && !skyCube;
    lastSize = '';
    resize();
  }
  // opt.fov：固定视角（弧度，客户端镜头动态移动关着时 = default_fov 1.0）；opt.dynFov：按距离变
  function dynFov() {
    if (!opt.dynFov && !opt.fov) return;
    const prop = Math.max(0, Math.min(1, camera.position.distanceTo(controls.target) * 1000 / 800000));
    setFov(THREE.MathUtils.radToDeg(opt.dynFov ? 0.55 + prop ** 0.35 * 0.55 : opt.fov));
  }
  function setFov(fov) {
    if (Math.abs(fov - camera.fov) < 1e-3) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
    bstMat.uniforms.scale.value = host.clientHeight * dpr / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
  }
  // ── 深渊口袋之间过导管的过场（sim-jump.js；view.abyssJump）──
  // 过场期间镜头由 createJumpSequence 接管（CAM_JUMP → 回到环绕镜头），交还后恢复 OrbitControls
  let jumpFx = null, jump = null, lastRender = 0;
  const vJ = new THREE.Vector3();
  const toScene = (w, out) => out.set((w.x - ORG[0]) * KM, (w.y - ORG[1]) * KM, (w.z - ORG[2]) * KM);
  function jumpFrame(dt) {
    if (!jump) return null;
    const si = hooks.self?.() ?? -1, d = drawn[si];
    const f = jump.seq.frame(dt, d ? [d.x / KM + ORG[0], d.y / KM + ORG[1], d.z / KM + ORG[2]] : null);
    jump.f = f;
    jump.hide = f.hideShip ? si : -1;
    jump.ship = d ? { pos: new THREE.Vector3(d.x, d.y, d.z), quat: heading[si] || new THREE.Quaternion() } : null;
    // FadeUIOut / FadeUIIn：总览图标层（图标、选中圈、名字）
    brMat.uniforms.fade.value = f.ui;
    lbl.style.opacity = f.ui < 1 ? String(f.ui) : '';
    if (f.cam) {
      toScene(f.cam.eye, camera.position);
      camera.lookAt(toScene(f.cam.at, vJ));
      setFov(THREE.MathUtils.radToDeg(f.cam.fov));
    }
    if (f.released && !jump.handed) {
      // 交还镜头：注视点 = 自己的船（环绕镜头的 at）
      jump.handed = true;
      if (f.cam) controls.target.copy(toScene(f.cam.at, vJ));
      controls.enabled = jump.ctl;
    }
    if (f.done) endJump();
    return f.cam ? f : null;
  }
  function endJump() {
    if (!jump) return;
    jump.seq.cancel(); jump.run.dispose();
    if (!jump.handed) {
      controls.enabled = jump.ctl;
      const d = drawn[hooks.self?.() ?? -1];
      if (d) controls.target.set(d.x, d.y, d.z);
    }
    brMat.uniforms.fade.value = 1;
    lbl.style.opacity = '';
    jump = null;
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
  // 导播镜头：绕战场中心慢慢转，离中心的距离按存活舰船散开的范围（有船被击毁也不切近景）
  let director = false, dirAng = 0.6, dirLast = 0;
  function directorStep() {
    const now = performance.now(), dt = dirLast ? Math.min(0.1, (now - dirLast) / 1000) : 0;
    dirLast = now;
    dirAng += dt * 0.06;
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
  controls.addEventListener('start', () => { if (director) { director = false; hooks.onDirector?.(false); } if (track >= 0) { track = -1; hooks.onTrack?.(-1); } });

  let rec = null;
  let lastT = -1, lastSize = '', lastN = -1, lastDrawT = 0;
  let follow = -1, followAt = null, flyTo = null;
  // 浮动原点（米，双精度）：跃迁动辄几个 AU，GPU 的单精度在那么远只剩几米到几公里的精度，模型会碎。
  // 画的时候所有世界坐标先减去 ORG；镜头注视点离 ORG 超过 REBASE 就把原点挪过去，镜头和注视点一起平移（画面不变）
  const ORG = [0, 0, 0], REBASE = 5e5;
  function rebase(wx, wy, wz) {
    const dx = wx - ORG[0], dy = wy - ORG[1], dz = wz - ORG[2];
    if (dx * dx + dy * dy + dz * dz < REBASE * REBASE) return;
    ORG[0] = wx; ORG[1] = wy; ORG[2] = wz;
    vA.set(dx * KM, dy * KM, dz * KM);
    camera.position.sub(vA);
    controls.target.sub(vA);
    followAt?.sub(vA);
    for (const d of drawn) if (d) { d.x -= vA.x; d.y -= vA.y; d.z -= vA.z; }
  }
  // 跟踪（客户端 SetAsCameraInterest）：镜头留在跟随的船上，转到让被跟踪的物体一直在船的正前方；手动拖镜头就停
  let track = -1;
  const tmp = new THREE.Object3D();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3();
  // 原生引擎（桌面版可选组件，native-engine.js → 桌面版 → eve-native host/bridge.py）：网页还是模拟的“大脑”，原生进程只负责画。
  //   位置单位米（场景坐标 × 1000，浮动原点和这里一样），坐标系同客户端 = three。
  //   清单（变了才发）：舰船 { id, dna（舰船索引外观键 hull.faction.race 换成冒号）, type, vmax, r, me（自己的船）, tur: [[挂点号, 炮塔模型键, 装备序号, 装备类型, 弹药类型]] }、
  //     残骸 { id: 'w' + 舰船序号, dna, kind: 'wreck', of: 舰船 id }（船爆了以后才有）、
  //     无人机实体（驾驶模拟放出去的，是单独的单位）{ id: 单位序号, dna, kind: 'drone', type, vmax, r }、
  //     战场模拟的无人机 / 舰载机（不是单位，按每帧的 dr 画）{ id: 'd' + 母舰 + '.' + 序号, dna, kind: 'drone', type }
  //     （type 原生那边查客户端图形表：爆炸、无人机炮塔；vmax 推进器亮度；r 半径，导弹瞄准用）
  //   每帧：t（模拟时间，秒）、相机 + 每个物体 [id, x, y, z, qx, qy, qz, qw, 可见, 目标 id, 开着的装备（位掩码，装备序号）, 护盾, 装甲, 结构（剩余比例）]
  //   事件（不能丢，单独发）：['shot', 开火方, 目标, 装备序号, 命中 0/1]（无人机实体的装备序号 0）、
  //     ['missile', 开火方, 目标, 装备序号, 弹药类型, 编号, 导弹速度 m/s]、['missileEnd', 编号, 命中 0/1]、['kill', id]；时间往回拨（重放、拖进度条）时不补发
  let nativeSink = null, nativeSig = '', nativeT = -1, nativeMis = 0;
  const nativeOpen = new Map();   // 已发出、还没结束的导弹：rec.missiles 的序号 → 编号
  const nDir = new THREE.Vector3(), nUp = new THREE.Vector3(), nQ = new THREE.Quaternion(), nM = new THREE.Matrix4();
  const dnaOf = (k) => k.replace(/\./g, ':');
  // 和 sim-fx.js 的 hash 一样：同一发炮弹在两边算出同一个开火时刻
  const hashT = (a, b = 0, c = 0) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  let nativeKillList = [];
  function nativeOut() {
    if (!nativeSink || !rec || !shipIndex) return;
    const t = lastDrawT, F = frameAt(t), n = rec.units.length;
    const list = [], rows = [];
    const tur = shipIndex.turrets || {};
    const me = hooks.self?.() ?? -1;
    const hpOf = (i) => (F.hp && i * 3 + 2 < F.hp.length ? [F.hp[i * 3] / 200, F.hp[i * 3 + 1] / 200, F.hp[i * 3 + 2] / 200] : [1, 1, 1]);
    for (let i = 0; i < n; i++) {
      const u = rec.units[i];
      const k = keyOf(i);
      if (!k) continue;
      const d = drawn[i], q = heading[i];
      const shown = !hooks.unitShown || hooks.unitShown(i) !== false;
      if (u.drone) list.push({ id: String(i), dna: dnaOf(k), kind: 'drone', type: u.ship, vmax: u.vel || 0, r: u.radius || 0 });
      else {
        // 炮塔（客户端 TurretSet.FitTurrets：高槽第 N 个装备挂到 locator_turret_N*）
        const tl = [];
        (u.rack || []).forEach((r, ri) => { if (r.slot === 'high' && tur[r.type]) tl.push([Number(String(r.key).split(':')[1]) + 1, tur[r.type], ri, r.type, r.charge || 0]); });
        list.push({ id: String(i), dna: dnaOf(k), type: u.ship, vmax: u.vel || 0, r: u.radius || 0, ...(i === me ? { me: 1 } : {}), ...(tl.length ? { tur: tl } : {}) });
      }
      const vis = d && d.alive && shown && !warpHidden(i, t) ? 1 : 0;
      const pos = d ? [d.x * 1000, d.y * 1000, d.z * 1000] : [0, 0, 0];
      const qq = q ? [q.x, q.y, q.z, q.w] : [0, 0, 0, 1];
      rows.push([String(i), ...pos, ...qq, vis, d?.alive && F.tg && F.tg[i] >= 0 ? String(F.tg[i]) : '', d?.alive && F.act ? F.act[i] : 0, ...hpOf(i)]);
      // 残骸：船爆了以后在原地换成残骸（朝向保持最后的朝向）；无人机不留残骸
      const w = d && !d.alive && !u.drone ? wreckKeyOf(i) : null;
      if (w) {
        list.push({ id: 'w' + i, dna: dnaOf(w), kind: 'wreck', of: String(i) });
        rows.push(['w' + i, ...pos, ...qq, shown ? 1 : 0, '', 0, 1, 1, 1]);
      }
    }
    // 战场模拟的无人机 / 舰载机：同 draw 里的插值（前后两帧按顺序对上就插值，朝向 = 移动方向）
    if (F.dr) {
      const F2 = rec.frames[Math.min(rec.frames.length - 1, Math.floor(t / rec.dt) + 1)];
      const fk = F2 === F ? 0 : Math.max(0, Math.min(1, (t - F.t) / (F2.t - F.t || 1)));
      const seen = new Map();
      for (let j = 0; j < F.dr.length; j += 6) {
        const o = F.dr[j], type = F.dr[j + 5], key = shipIndex.types?.[type]?.m;
        if (!key || !drawn[o]?.alive) continue;
        const c = seen.get(o) || 0;
        seen.set(o, c + 1);
        const id = `d${o}.${c}`;
        const same = F2.dr[j] === o && F2.dr[j + 5] === type;
        const p = [0, 1, 2].map((a) => (F.dr[j + 1 + a] + (same ? (F2.dr[j + 1 + a] - F.dr[j + 1 + a]) * fk : 0) - ORG[a]) * KM * 1000);
        nQ.identity();
        if (same) {
          vA.set(F2.dr[j + 1] - F.dr[j + 1], F2.dr[j + 2] - F.dr[j + 2], F2.dr[j + 3] - F.dr[j + 3]);
          if (vA.lengthSq() > 1e-6) nQ.setFromRotationMatrix(nM.lookAt(vB.set(0, 0, 0), vA.negate(), vC.set(0, 1, 0)));
        }
        list.push({ id, dna: dnaOf(key), kind: 'drone', type });
        rows.push([id, ...p, nQ.x, nQ.y, nQ.z, nQ.w, 1, '', 0, 1, 1, 1]);
      }
    }
    const sig = list.map((x) => `${x.id}=${x.dna}${x.me ? '*' : ''}${x.tur ? '+' + x.tur.map((y) => y.join('/')).join(';') : ''}`).join(',');
    if (sig !== nativeSig) { nativeSig = sig; nativeSink.ships(list); }
    // 事件：上次发到的时间之后、这次画到的时间之前
    const ev = [];
    if (nativeT >= 0 && t > nativeT && t - nativeT < 5) {
      const dt = rec.dt;
      for (let k = Math.floor(nativeT / dt); k <= Math.floor(t / dt); k++) {
        const fr = rec.frames[k];
        if (!fr) continue;
        const sh = fr.shots || [];
        for (let j = 0; j < sh.length; j += 4) {
          const from = sh[j], to = sh[j + 1], kind = sh[j + 2], g = sh[j + 3];
          if (kind > 1) continue;   // 遥修、冲击波另算
          const tf = fr.t - dt + hashT(k * 977 + j, 11) * dt;   // 和 sim-fx 一样把一帧里的开火摊开
          if (tf <= nativeT || tf > t) continue;
          const fx = rec.units[from]?.fx?.[g];
          if (!fx || fx.w === 'missile' || fx.w === 'doom') continue;
          ev.push(['shot', String(from), String(to), rec.units[from].gm?.[g] ?? -1, kind]);
        }
        const ds = fr.ds || [];
        for (let j = 0; j < ds.length; j += 3) {
          const tf = fr.t - dt + hashT(k * 977 + j, 13) * dt;
          if (tf > nativeT && tf <= t) ev.push(['shot', String(ds[j]), String(ds[j + 1]), 0, ds[j + 2]]);
        }
      }
      const M = rec.missiles || [];
      for (let j = M.length - 1; j >= 0 && M[j].t0 > nativeT - 60; j--) {
        const m = M[j];
        if (m.t0 > nativeT && m.t0 <= t && !nativeOpen.has(j)) {
          const ri = rec.units[m.f]?.gm?.[m.k] ?? -1;
          nativeOpen.set(j, ++nativeMis);
          ev.push(['missile', String(m.f), String(m.to), ri, rec.units[m.f]?.rack?.[ri]?.charge || 0, nativeMis, m.v || 0]);
        }
      }
      for (const [j, id] of nativeOpen) {
        const m = M[j];
        if (!m) { nativeOpen.delete(j); continue; }
        if (m.t1 != null && m.t1 <= t) { ev.push(['missileEnd', id, m.hit ? 1 : 0]); nativeOpen.delete(j); }
        else if (t - m.t0 > 60) nativeOpen.delete(j);
      }
      for (const x of nativeKillList) if (x.at > nativeT && x.at <= t) ev.push(['kill', String(x.unit)]);
      // 跃迁（引擎事件 kind 'warp'）：进入 / 退出跃迁（推进器 warpIntensity）；别人的起跳 / 落地闪光（短于 4 万 km 不播，同 warpFlashes）
      const pm = (i) => (drawn[i] ? [drawn[i].x * 1000, drawn[i].y * 1000, drawn[i].z * 1000] : []);
      for (const e of rec.events || []) {
        if (e.kind !== 'warp') continue;
        const id = String(e.unit), flash = e.tOut != null && e.unit !== me && e.D >= 4e7;
        if (e.t > nativeT && e.t <= t) ev.push(['warp', id, 1]);
        if (flash && e.tOut > nativeT && e.tOut <= t) ev.push(['warpOut', id, ...e.dir, ...pm(e.unit)]);
        if (e.tIn != null && e.tIn > nativeT && e.tIn <= t) {
          if (flash) ev.push(['warpIn', id, ...pm(e.unit)]);
          ev.push(['warp', id, 0]);
        }
      }
    } else nativeOpen.clear();
    nativeT = t;
    if (ev.length) nativeSink.fx(ev);
    const e = camera.position;
    camera.getWorldDirection(nDir);
    nUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const ws = hooks.warpFx?.();   // 自己的船在跃迁中：原生那边画跃迁隧道（方向、速度比例同网页的隧道）
    nativeSink.frame({
      ...(ws ? { warp: [ws.dir[0], ws.dir[1], ws.dir[2], ws.sf] } : {}),
      st: t,   // 模拟时间（"t" 是消息类型，不能重名）
      cam: { eye: [e.x * 1000, e.y * 1000, e.z * 1000], target: [(e.x + nDir.x) * 1000, (e.y + nDir.y) * 1000, (e.z + nDir.z) * 1000],
        up: [nUp.x, nUp.y, nUp.z], fov: THREE.MathUtils.degToRad(camera.fov) },
      ships: rows,
    });
  }
  const drawn = [];      // 本帧每艘船的位置（千米，悬停 / 选中用）
  const heading = [];    // 每艘船最后的朝向（停下 / 成为残骸后保持）
  const bank = [], bankT = [];   // 每艘船当前侧倾角（弧度）和上次更新的时间
  const qBank = new THREE.Quaternion(), AXIS_Z = new THREE.Vector3(0, 0, 1);

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
  // 微跳事件（引擎 events 里 kind = mjd，t = 落地那一帧的时间）：单位 → 落地帧时间集合
  let jumpN = -1, jumpRec = null;
  const jumps = new Map();
  function jumped(i, t) {
    const ev = rec.events || [];
    if (ev.length !== jumpN || jumpRec !== rec) { jumpN = ev.length; jumpRec = rec; jumps.clear(); for (const e of ev) if (e.kind === 'mjd') (jumps.get(e.unit) || jumps.set(e.unit, new Set()).get(e.unit)).add(e.t); }
    return jumps.get(i)?.has(t) || false;
  }
  function posAt(i, t, out) {
    const F = rec.frames, dt = rec.dt;
    const k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt)));
    const a = F[k], b = F[Math.min(F.length - 1, k + 1)];
    if (i * 3 >= a.pos.length) return null;
    // 微跳：客户端是瞬移（原地消失、落点出现），这一段不插值，到下一帧直接跳过去
    const f = b === a || i * 3 >= b.pos.length || jumped(i, b.t) ? 0 : Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
    out.set(
      (a.pos[i * 3] + (b.pos[i * 3] - a.pos[i * 3]) * f - ORG[0]) * KM,
      (a.pos[i * 3 + 1] + (b.pos[i * 3 + 1] - a.pos[i * 3 + 1]) * f - ORG[1]) * KM,
      (a.pos[i * 3 + 2] + (b.pos[i * 3 + 2] - a.pos[i * 3 + 2]) * f - ORG[2]) * KM);
    return out;
  }
  // 船头方向（引擎记录的 hd，单位向量）：两帧之间线性插值再归一化；没有记录返回 null
  function hdAt(i, t, out) {
    const F = rec.frames, dt = rec.dt;
    const k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt)));
    const a = F[k].hd, b = F[Math.min(F.length - 1, k + 1)].hd || a;
    if (!a || i * 3 >= a.length) return null;
    const f = Math.max(0, Math.min(1, (t - F[k].t) / dt));
    out.set(a[i * 3] + (b[i * 3] - a[i * 3]) * f, a[i * 3 + 1] + (b[i * 3 + 1] - a[i * 3 + 1]) * f, a[i * 3 + 2] + (b[i * 3 + 2] - a[i * 3 + 2]) * f);
    const l = out.length();
    return l > 1e-6 ? out.multiplyScalar(1 / l) : null;
  }
  const frameAt = (t) => rec.frames[Math.max(0, Math.min(rec.frames.length - 1, Math.floor(t / rec.dt)))];

  function fit() {
    if (!rec) return;
    follow = -1; flyTo = null;
    const f = rec.frames[rec.frames.length - 1];
    const box = new THREE.Box3();
    for (let i = 0; i < f.pos.length; i += 3) box.expandByPoint(vA.set((f.pos[i] - ORG[0]) * KM, (f.pos[i + 1] - ORG[1]) * KM, (f.pos[i + 2] - ORG[2]) * KM));
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
    nativeKillList = opt.kills || [];
    sel = opt.sel ?? -1;
    selC = opt.selC ?? -1;
    const n = rec.units.length;
    if (n !== lastN) { lastN = n; syncModels(); }
    {
      const w = follow >= 0 ? posAt(follow, t, vC) : null;
      if (w) rebase(w.x / KM + ORG[0], w.y / KM + ORG[1], w.z / KM + ORG[2]);
      else rebase(controls.target.x / KM + ORG[0], controls.target.y / KM + ORG[1], controls.target.z / KM + ORG[2]);
    }
    // 舰船位置、朝向
    for (let i = 0; i < n; i++) {
      const p = posAt(i, t, vA);
      drawn[i] = null;
      const esc = rec.units[i].escaped;
      if (!p || (esc != null && t >= esc)) continue;   // 没入场 / 已跃迁离场
      const alive = F.hp[i * 3 + 2] > 0 || (i * 3 >= F.hp.length);
      if (!alive && rec.units[i].drone) continue;   // 无人机被打爆不留残骸（只有爆炸）
      const q = posAt(i, t + rec.dt, vB) || p;
      if (!heading[i]) heading[i] = new THREE.Quaternion();
      // 朝向：引擎记录的船头方向（hd，和速度分开积分，停着也会慢慢转）；旧记录 / 无人机没有 → 用速度方向
      const h = alive ? hdAt(i, t, vD) : null;
      if (h || (alive && q.distanceToSquared(p) > 1e-12)) {
        tmp.position.copy(p); tmp.lookAt(h ? vD.add(p) : q); heading[i].copy(tmp.quaternion);
        // 转弯侧倾：客户端没有（姿态由服务器下发），这里按水平转向角速度近似：bank = clamp(-2 × ω, ±30°)，平滑进出弯
        const o = posAt(i, Math.max(0, t - rec.dt), vC);
        let target = 0;
        if (o && p.distanceToSquared(o) > 1e-12) {
          const ax = p.x - o.x, az = p.z - o.z, bx = q.x - p.x, bz = q.z - p.z;
          const w = Math.atan2(ax * bz - az * bx, ax * bx + az * bz) / rec.dt;   // 绕世界上方向的转向角速度（弧度 / 秒）
          target = Math.max(-0.52, Math.min(0.52, 2 * w));
        }
        const k = Math.min(1, Math.max(0, t - (bankT[i] ?? t)) * 1.5);
        bank[i] = (bank[i] || 0) + (target - (bank[i] || 0)) * k;
        bankT[i] = t;
        if (bank[i]) heading[i].multiply(qBank.setFromAxisAngle(AXIS_Z, bank[i]));
      }
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

    if (track >= 0) {
      const e = drawn[follow], g = drawn[track];
      if (!g?.alive || !e) { track = -1; hooks.onTrack?.(-1); }
      else {
        vA.set(e.x - g.x, e.y - g.y, e.z - g.z);
        if (vA.lengthSq() > 1e-12) {
          vA.normalize(); vA.y += 0.2; vA.normalize();
          vB.copy(controls.target).addScaledVector(vA, camera.position.distanceTo(controls.target));
          camera.position.lerp(vB, 0.12);
        }
      }
    }
    if (director && follow < 0) directorStep();
    // 模型实例
    const white = new THREE.Color(1, 1, 1), dark = new THREE.Color(0.22, 0.2, 0), live = new THREE.Color();
    const bp = [], bc = [], bs = [], fl = [], gw = [];
    const hfxNow = performance.now() / 1000;
    ckTime.value = SHIP_TIME.value = hfxNow; renderer.getDrawingBufferSize(ckVp);
    const shOn = shl.has();
    for (const m of models.values()) {
      if (m.state !== 'ok' || !m.mesh) continue;
      let c = 0, shX = 0, shY = 0, shZ = 0;
      const shI = shAttr(m.mesh, m.mesh.instanceMatrix.count);
      for (const o of Object.values(m.hfx || {})) o.userData.n = 0;
      for (const i of m.units) {
        const d = drawn[i];
        if (!d) continue;
        // 残骸模型只画死了的船；原船模型在残骸模型加载好之后就不再画死了的（没有残骸模型时仍用变暗的原船）
        if (m.wreck ? d.alive : !d.alive && wreckReady(i)) continue;
        tmp.position.set(d.x, d.y, d.z);
        tmp.quaternion.copy(heading[i] || tmp.quaternion.identity());
        // 残骸不转：客户端 Wreck.SetBallRotation 直接沿用爆掉那艘船的姿态（yaw/pitch/roll），之后静止
        tmp.scale.setScalar(KM);
        tmp.updateMatrix();
        const wh = d.alive && !m.wreck && (warpHidden(i, t) || i === (jump?.hide ?? -1));   // 过导管：自己的船 0.88–5 秒藏起来
        const ck = d.alive && !m.wreck && !wh ? cloakAt(i, t) : null;
        // 隐形：溶解中（或自己的船隐形期间）画进隐形实例（裁剪过的船体 + 过渡 / 加色 / 扭曲层）；别人的船溶完（CloakAmount 到 1.13）什么都不画
        if (ck && (ck.self || ck.f < 1.129)) ckPush(m, ck, tmp.matrix);
        else if (!wh && !ck) {
          m.mesh.setMatrixAt(c, tmp.matrix);
          // 实例颜色 r = 变暗、g = shipData.y、b = 推进器亮度（船体热光开关，sim-ships.js）：活船按速度比（同下面喷口强度），残骸 1（非 EveShip2，引擎默认 1）
          if (d.alive && !m.wreck) { const sp = F.spd ? F.spd[i] : 0; live.setRGB(1, 1, F.wp && F.wp[i] === 2 ? 1 : Math.min(1, sp / Math.max(1, rec.units[i].vel || 1))); }
          m.mesh.setColorAt(c, d.alive && !m.wreck ? live : m.wreck ? white : dark);
          // 二次光照接收者强度：按屏幕直径（EveSpaceObject2::UpdateShLighting）；系数按这一组实例的中心算（光源都是行星 / 卫星，远）
          shI.array[c] = shOn ? shKOf(m.def.r, camera.position.distanceTo(tmp.position) / KM) : 0;
          shX += d.x; shY += d.y; shZ += d.z;
          if (m.def.bl) { if (!m.wf || m.wf.length < m.mesh.instanceMatrix.count) m.wf = new Uint8Array(m.mesh.instanceMatrix.count); m.wf[c] = d.alive && !m.wreck && F.wp && F.wp[i] === 2 ? 1 : 0; }   // 推进器灯换跃迁半径 / 颜色（sim-lights.js）
          c++;
        }
        // 炮塔 / 尾焰：activationStrength ≤ 0.5 时不画（EveMobile.DisplayChildren）
        const kids = !wh && !(ck && ck.act <= 0.5);
        if (d.alive && !m.wreck && kids) for (const mt of mountsOf(i, m.def)) {
          const tm = tModels.get(mt.k);
          if (tm?.state === 'ok') tm.list.push(new THREE.Matrix4().multiplyMatrices(tmp.matrix, mt.mat));
        }
        // 船身叠加特效：同一种特效多件装备取最亮的
        if (d.alive && !wh && !(ck && ck.f >= 1)) {
          const rack = rec.units[i].rack || [];
          const best = {};
          for (let j = 0; j < rack.length && j < 32; j++) {
            const kind = rack[j].hfx;
            if (!kind || !HFX[kind]) continue;
            const H = HFX[kind];
            if (H.passes) {   // fx3dv5 类：实例颜色带曲线值（亮度、UvOffset）；开着时每个模块周期从头播一次（10 秒曲线，周期 17.5 秒）
              const age = hfxAge(i, j, t, { loop: true, len: rack[j].cycle || H.len });
              if (age < 0 || age >= H.len) continue;
              const c = new THREE.Color(curveAt(H.curve, age), age / H.len, 0);
              if (!best[kind + '#0'] || c.r > best[kind + '#0'].r) H.passes.forEach((_, p) => { best[kind + '#' + p] = c; });
              continue;
            }
            const col = hfxCurve(H, hfxAge(i, j, t, H));
            if (col && (!best[kind] || col.r + col.g + col.b > best[kind].r + best[kind].g + best[kind].b)) best[kind] = col.clone();
          }
          for (const kind in best) {
            let o = m.hfx[kind];
            if (!o) {
              o = m.hfx[kind] = new THREE.InstancedMesh(m.def.geometry, hfxMat(kind, m.def), m.units.length);
              o.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
              o.setColorAt(0, white);
              o.frustumCulled = false; o.renderOrder = 2;
              o.userData.n = 0;
              scene.add(o);
            }
            o.setMatrixAt(o.userData.n, tmp.matrix);
            o.setColorAt(o.userData.n, best[kind]);
            o.userData.n++;
          }
        }
        if (d.alive && kids) {
          // 强度：当前速度 / 最大速度（客户端 FitBoosters 把 maxVelocity 交给引擎；引擎内部的强度曲线未知，这里直接用速度比，开推进器时超过 1）
          const u = rec.units[i], sp = F.spd ? F.spd[i] : 0;
          // 跃迁中（客户端 ship.EnterWarp）：boosters.warpIntensity = 1，强度固定为 1，换跃迁颜色（warpGlowColor / warpHaloColor / WarpColor0）
          const warping = F.wp ? F.wp[i] === 2 : false;
          const I = warping ? 1 : Math.max(0, Math.min(2, sp / Math.max(1, u.vel || 1)));
          if (I > 0.0001) {
            const B = m.def.bst || BST_DEF;
            const zk = 0.5 + 0.5 * Math.min(1, I), gk = Math.min(1, I);
            let gl = B.glow || BST_DEF.glow, hl = B.halo || BST_DEF.halo;
            const sym = B.sym ?? BST_DEF.sym;
            if (warping && B.wglow) gl = [gl[0], ...B.wglow];
            if (warping && B.whalo) hl = [hl[0], hl[1], ...B.whalo];
            for (const b of m.def.boosters) {
              // 盒子：船矩阵 × 平移到喷口 × 缩放（米）
              mBst.makeScale(b[3], b[3], b[4] * zk).setPosition(b[0], b[1], b[2]);
              mBst2.multiplyMatrices(tmp.matrix, mBst);
              fl.push(...mBst2.elements, ...(B.a0 || BST_DEF.a0), ...(B.a1 || BST_DEF.a1), ...(B.fq || BST_DEF.fq), ...((warping && B.wc0) || B.c0 || BST_DEF.c0), (i * 7.13 + b[0]) % 1, b[5] || 0, I);
              vA.set(b[0], b[1], b[2]).applyMatrix4(tmp.matrix);
              const ph = (i * 0.37 + b[1] * 0.11) % 1, w = b[3] * KM;
              gw.push(vA.x, vA.y, vA.z, w * gl[0], w * gl[0], ph, gl[1] * gk, gl[2] * gk, gl[3] * gk);
              gw.push(vA.x, vA.y, vA.z, w * sym, w * sym, ph, hl[2] * gk, hl[3] * gk, hl[4] * gk);
              gw.push(vA.x, vA.y, vA.z, w * hl[0], w * hl[1], ph, hl[2] * gk, hl[3] * gk, hl[4] * gk);
            }
          }
        }
      }
      m.mesh.count = c;
      m.mesh.instanceMatrix.needsUpdate = true;
      if (m.mesh.instanceColor) m.mesh.instanceColor.needsUpdate = true;
      shI.needsUpdate = true;
      if (shOn && c && m.def.shl) shl.at([shX / c / KM + ORG[0], shY / c / KM + ORG[1], shZ / c / KM + ORG[2]], shDir.copy(sunDir).normalize(), m.def.r * 0.3, m.def.shl.sh.value);
      ckFlush(m);
      if (m === lastModel()) flushTurrets();
      for (const o of Object.values(m.hfx || {})) {
        o.count = o.userData.n;
        o.instanceMatrix.needsUpdate = true;
        if (o.instanceColor) o.instanceColor.needsUpdate = true;
        o.material.uniforms.time.value = hfxNow;
      }
    }
    if (bp.length / 3 > bstCap) { bstCap = Math.ceil(bp.length / 3 * 1.5) + 64; bstGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bstCap * 3), 3)); bstGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bstCap * 3), 3)); bstGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(bstCap), 1)); }
    if (bstCap) {
      bstGeo.attributes.position.array.set(bp); bstGeo.attributes.color.array.set(bc); bstGeo.attributes.size.array.set(bs);
      bstGeo.attributes.position.needsUpdate = bstGeo.attributes.color.needsUpdate = bstGeo.attributes.size.needsUpdate = true;
      bstGeo.setDrawRange(0, bp.length / 3);
    }
    // 喷口火焰 / 光点实例
    const fill = (geo, ATTR, data, cap) => {
      const stride = ATTR.reduce((a, x) => a + x[1], 0), n = data.length / stride;
      if (n > cap) { cap = Math.ceil(n * 1.5) + 32; for (const [name, w] of ATTR) geo.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(cap * w), w)); }
      if (cap) {
        let o = 0;
        const A = ATTR.map(([name, w]) => [geo.attributes[name].array, w]);
        for (let j = 0; j < n; j++) for (const [arr, w] of A) for (let c = 0; c < w; c++) arr[j * w + c] = data[o++];
        for (const [name] of ATTR) geo.attributes[name].needsUpdate = true;
      }
      geo.instanceCount = n;
      return cap;
    };
    flameCap = fill(flameGeo, FLAME_ATTR, fl, flameCap);
    glowCap = fill(glowGeo, GLOW_ATTR, gw, glowCap);
    flameMat.uniforms.time.value = glowMat.uniforms.time.value = performance.now() / 1000;

    // 总览图标：模型在屏幕上够大时淡出
    const ip = [], it = [], ii = [], fp = [], ff = [];
    // 天体图标（灰白，按总览页签过滤：hooks.celShown）
    celUpdate();
    if (brkOf) for (let c = 0; c < cels.count(); c++) {
      const p = cels.pos(c), cc = rec.cel[c];
      if (!p || (hooks.celShown && !hooks.celShown(c))) continue;
      const k = brSlot(cc.brk || CEL_BRK[cc.group] || CEL_BRK[7]);   // brk：单个天体自己的图标（残骸有物品 / 已拾取）
      if (k < 0) continue;
      const on = c === (opt.selC ?? -1) || c === hoverC;
      ip.push(p.x, p.y, p.z); it.push(on ? 1 : 0.78, on ? 1 : 0.8, on ? 1 : 0.84, on ? 1 : 0.8); ii.push(k);
    }
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d || (hooks.unitShown && !hooks.unitShown(i))) continue;
      vA.set(d.x, d.y, d.z);
      const px = radiusOf(i) / kmPerPx(vA);
      const hasModel = models.get(keyOf(i))?.state === 'ok';
      const a = hasModel && !brkOf ? Math.max(0, Math.min(1, 1 - (px - 14) / 26)) : 1;
      if (a <= 0 && opt.sel !== i) continue;
      const ic = d.alive ? iconOf(i) : wreckIcon();
      if (ic < 0) continue;
      // 图标颜色（客户端 bracketVarious.GetIconColor）：舰船一律 OVERVIEW_NORMAL_COLOR 白色，自己的船 OVERVIEW_OWN_SHIP_COLOR 0.7 灰；敌我看旁边的状态旗
      const own = i === hooks.self?.();
      const c = d.alive ? (own ? OWN_COL : WHITE) : WRECK;
      const hi = opt.sel === i ? 1.35 : 1;
      const al = Math.max(a, opt.sel === i ? 0.5 : 0) * (d.alive ? 1 : 0.8);
      ip.push(d.x, d.y, d.z);
      it.push(Math.min(1, c.r * hi), Math.min(1, c.g * hi), Math.min(1, c.b * hi), al);
      ii.push(ic);
      if (d.alive && !own) { fp.push(d.x, d.y, d.z); ff.push(sideOf(rec.units[i].side) === 'A' ? 1 : 0, al); }
    }
    // 无人机 / 舰载机：前后两帧按顺序对上（同一母舰、同一类别）就插值
    const F2 = rec.frames[Math.min(rec.frames.length - 1, Math.floor(t / rec.dt) + 1)];
    const fk = F2 === F ? 0 : Math.max(0, Math.min(1, (t - F.t) / (F2.t - F.t || 1)));
    // 每架 6 个数：母舰、x、y、z、类别、类型 ID；有模型的画模型（朝向 = 前后两帧的移动方向），模型在屏幕上够大时图标淡出
    const dPos = new Map();   // 外观键 → [x, y, z, 朝向四元数…]
    for (let j = 0; j < F.dr.length; j += 6) {
      const o = F.dr[j];
      if (!drawn[o]?.alive) continue;
      const same = F2.dr[j] === o && F2.dr[j + 5] === F.dr[j + 5];
      const x = (F.dr[j + 1] + (same ? (F2.dr[j + 1] - F.dr[j + 1]) * fk : 0) - ORG[0]) * KM, y = (F.dr[j + 2] + (same ? (F2.dr[j + 2] - F.dr[j + 2]) * fk : 0) - ORG[1]) * KM, z = (F.dr[j + 3] + (same ? (F2.dr[j + 3] - F.dr[j + 3]) * fk : 0) - ORG[2]) * KM;
      const key = shipIndex?.types?.[F.dr[j + 5]]?.m;
      let a = 1;
      if (key) {
        const dm = droneModel(key);
        if (dm.state === 'ok') {
          vA.set(x, y, z);
          const px = (shipIndex.models[key]?.r || 5) * KM / kmPerPx(vA);
          a = Math.max(0, Math.min(1, 1 - (px - 6) / 10));
          tmp.position.set(x, y, z);
          if (same) { vB.set((F2.dr[j + 1] - ORG[0]) * KM, (F2.dr[j + 2] - ORG[1]) * KM, (F2.dr[j + 3] - ORG[2]) * KM); if (vB.distanceToSquared(vA.set((F.dr[j + 1] - ORG[0]) * KM, (F.dr[j + 2] - ORG[1]) * KM, (F.dr[j + 3] - ORG[2]) * KM)) > 1e-14) { tmp.lookAt(vB.add(tmp.position).sub(vA)); } }
          (dPos.get(key) || dPos.set(key, []).get(key)).push(tmp.position.x, tmp.position.y, tmp.position.z, tmp.quaternion.x, tmp.quaternion.y, tmp.quaternion.z, tmp.quaternion.w);
          tmp.quaternion.identity();
        }
      }
      const dic = brkOf ? brSlot(brkOf(F.dr[j + 5])) : DRONE_BRACKETS[F.dr[j + 4]] ?? DRONE_BRACKETS[0];
      if (a <= 0 || dic < 0) continue;
      ip.push(x, y, z);
      it.push(1, 1, 1, a);
      ii.push(dic);
      fp.push(x, y, z); ff.push(sideOf(rec.units[o].side) === 'A' ? 1 : 0, a);
    }
    for (const [k, m] of dModels) {
      if (m.state !== 'ok') continue;
      const L = dPos.get(k) || [];
      const cnt = L.length / 7;
      if (cnt > m.cap) { m.cap = Math.ceil(cnt * 1.5) + 4; if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); } m.mesh = new THREE.InstancedMesh(m.def.geometry, m.def.materials, m.cap); m.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); shAttr(m.mesh, m.cap); m.mesh.castShadow = m.mesh.receiveShadow = true; m.mesh.layers.enable(SSAO_LAYER); m.mesh.frustumCulled = false; scene.add(m.mesh); }
      if (!m.mesh) continue;
      for (let c = 0; c < cnt; c++) {
        tmp.position.set(L[c * 7], L[c * 7 + 1], L[c * 7 + 2]);
        tmp.quaternion.set(L[c * 7 + 3], L[c * 7 + 4], L[c * 7 + 5], L[c * 7 + 6]);
        tmp.scale.setScalar(KM);
        tmp.updateMatrix();
        m.mesh.setMatrixAt(c, tmp.matrix);
      }
      tmp.quaternion.identity(); tmp.scale.setScalar(1);
      m.mesh.count = cnt;
      m.mesh.instanceMatrix.needsUpdate = true;
    }
    if (ip.length / 3 > brCap) { brCap = Math.ceil(ip.length / 3 * 1.5) + 64; brGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(brCap * 3), 3)); brGeo.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(brCap * 4), 4)); brGeo.setAttribute('icon', new THREE.BufferAttribute(new Float32Array(brCap), 1)); }
    if (brCap) {
      brGeo.attributes.position.array.set(ip); brGeo.attributes.tint.array.set(it); brGeo.attributes.icon.array.set(ii);
      brGeo.attributes.position.needsUpdate = brGeo.attributes.tint.needsUpdate = brGeo.attributes.icon.needsUpdate = true;
      brGeo.setDrawRange(0, ip.length / 3);
    }
    if (fp.length / 3 > flCap) { flCap = Math.ceil(fp.length / 3 * 1.5) + 64; flGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flCap * 3), 3)); flGeo.setAttribute('fl', new THREE.BufferAttribute(new Float32Array(flCap * 2), 2)); }
    if (flCap) {
      flGeo.attributes.position.array.set(fp); flGeo.attributes.fl.array.set(ff);
      flGeo.attributes.position.needsUpdate = flGeo.attributes.fl.needsUpdate = true;
      flGeo.setDrawRange(0, fp.length / 3);
      // 旗子中心相对图标中心：(9 + 4.5 − 8, 8 + 4.5 − 8) = (5.5, 4.5) 像素，换成裁剪空间
      const cw = renderer.domElement.width / dpr || 1, ch = renderer.domElement.height / dpr || 1;
      flMat.uniforms.off.value.set(5.5 * 2 / cw, -4.5 * 2 / ch);
    }

    // 开火、导弹、命中、阵亡爆炸（sim-fx.js）
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d) { atV[i] = null; continue; }
      atV[i] = (atV[i] || new THREE.Vector3()).set(d.x, d.y, d.z);
    }
    fx.update(t, P, opt.kills);
    drawTac();
    drawBubbles(t);
    // 诱导进场闪光：进场后 4 秒内先亮后暗
    {
      const fp = flashGeo.attributes.position.array, fc = flashGeo.attributes.color.array, fs = flashGeo.attributes.size.array;
      let c = 0;
      for (const e of rec.events) {
        if (!(e.kind === 'cyno' || (e.kind === 'reinforce' && e.mode === 'cyno')) || !e.pos || c >= 16) continue;
        const age = t - e.t;
        if (age < 0 || age > 4) continue;
        const k = age < 0.4 ? age / 0.4 : 1 - (age - 0.4) / 3.6;
        fp.set([(e.pos[0] - ORG[0]) * KM, (e.pos[1] - ORG[1]) * KM, (e.pos[2] - ORG[2]) * KM], c * 3);
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
    drawTacOverlay();
    drawPlacing();
    if (!labels || !rec) return;
    const w = lbl.width, h = lbl.height;
    lctx.font = `${11 * dpr}px system-ui, sans-serif`;
    lctx.textBaseline = 'middle';
    lctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    lctx.shadowBlur = 3 * dpr;
    // 挤在一起时与已写的名字重叠就不写（选中 / 悬停的船先写）
    const lh = 13 * dpr;
    const boxes = [];
    for (const c of new Set([selC, hoverC])) {
      const p = c >= 0 && cels.pos(c), name = p && hooks.celName?.(c);
      if (!name) continue;
      vA.copy(p).project(camera);
      if (vA.z > 1) continue;
      const x = (vA.x + 1) / 2 * w + 14 * dpr, y = (1 - vA.y) / 2 * h - 4 * dpr;
      lctx.fillStyle = '#d8dde4';
      lctx.fillText(name, x, y);
      boxes.push([x, y, x + lctx.measureText(name).width]);
    }
    const order = drawn.map((p, i) => i).sort((a, b) => (b === sel || b === hover) - (a === sel || a === hover));
    for (const i of order) {
      const p = drawn[i];
      if (!p?.alive) continue;
      vA.set(p.x, p.y, p.z).project(camera);
      if (vA.z > 1 || Math.abs(vA.x) > 1.1 || Math.abs(vA.y) > 1.1) continue;
      const name = hooks.nameOf?.(i);
      if (!name) continue;
      const x = (vA.x + 1) / 2 * w + 14 * dpr, y = (1 - vA.y) / 2 * h - 4 * dpr, tw = lctx.measureText(name).width;
      if (boxes.some((r) => x < r[2] && x + tw > r[0] && Math.abs(y - r[1]) < lh)) continue;
      boxes.push([x, y, x + tw]);
      lctx.fillStyle = sideOf(rec.units[i].side) === 'A' ? '#9cc2ff' : '#ff9d94';
      lctx.fillText(name, x, y);
    }
  }

  // 屏幕上一点对应的飞行方向（镜头射线方向，单位向量）
  function dirAt(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect();
    if (!r.width) return null;
    ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const d = ray.ray.direction;
    return [d.x, d.y, d.z];
  }
  // 第 i 艘船在屏幕上的位置（CSS 像素，相对画布）；不在画面里返回 null
  function screenOf(i) {
    const p = drawn[i];
    if (!p) return null;
    vA.set(p.x, p.y, p.z).project(camera);
    if (vA.z > 1) return null;
    return [(vA.x + 1) / 2 * host.clientWidth, (1 - vA.y) / 2 * host.clientHeight];
  }
  // 悬停 / 点击：按屏幕距离找最近的船
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = 22 * 22;
    drawn.forEach((p, i) => {
      if (!p || (hooks.unitShown && !hooks.unitShown(i))) return;
      vA.set(p.x, p.y, p.z).project(camera);
      if (vA.z > 1) return;
      const sx = (vA.x + 1) / 2 * r.width, sy = (1 - vA.y) / 2 * r.height;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    let bc = -1;
    if (best < 0 && rec?.cel) for (let c = 0; c < cels.count(); c++) {
      const p = cels.pos(c);
      if (!p || (hooks.celShown && !hooks.celShown(c))) continue;
      vA.copy(p).project(camera);
      if (vA.z > 1) continue;
      const d = ((vA.x + 1) / 2 * r.width - x) ** 2 + ((1 - vA.y) / 2 * r.height - y) ** 2;
      if (d < bd) { bd = d; bc = c; }
    }
    return { i: best, c: bc, x, y };
  }
  let down = null;
  const el = renderer.domElement;
  let rdown = null;   // 右键按下的位置：右键拖动（平移镜头）后不弹菜单
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; if (e.button === 2) rdown = down; });
  el.addEventListener('pointerup', (e) => {
    if (placing && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) {
      const p = planePoint(e.clientX, e.clientY);
      if (p) { const cb = placing.done; placing = null; el.style.cursor = ''; cb([p.x / KM + ORG[0], p.y / KM + ORG[1], p.z / KM + ORG[2]]); }
      down = null;
      return;
    }
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) { const p = pick(e); if (p.c >= 0 && hooks.onPickCel) hooks.onPickCel(p.c, e); else hooks.onPick?.(p.i, e); }
    down = null;
  });
  // 右键：把鼠标下的船 / 天体交给外面（自己船的右键菜单等）
  el.addEventListener('contextmenu', (e) => { if (placing) return; if (rdown && Math.hypot(e.clientX - rdown[0], e.clientY - rdown[1]) >= 6) { e.preventDefault(); return; } const p = pick(e); hooks.onCtx?.(p.i, p.c, e); });
  el.addEventListener('dblclick', (e) => {
    const pk = pick(e), i = pk.i;
    if (pk.c >= 0 && hooks.onDblCel) { hooks.onDblCel(pk.c, e); return; }
    // 驾驶模拟：双击空白处朝那个方向飞（hooks.onDblEmpty 收到单位方向向量）
    if (i < 0 && hooks.onDblEmpty) { const d = dirAt(e.clientX, e.clientY); if (d) hooks.onDblEmpty(d, e); return; }
    if (i >= 0 && hooks.onFollowDbl === false) return;
    if (i >= 0) { setFollow(i); hooks.onFollow?.(i); }
  });
  el.addEventListener('pointermove', (e) => { mouse = [e.clientX, e.clientY]; });
  el.addEventListener('pointerdown', (e) => { mouse = [e.clientX, e.clientY]; });
  el.addEventListener('pointerleave', () => { mouse = null; });
  el.addEventListener('pointermove', (e) => { if (placing) return; if (e.pointerType === 'mouse' && !e.buttons) { const p = pick(e); hover = p.i; hoverC = p.c; hooks.onHover?.(p.i, p.x, p.y, p.c); } });
  el.addEventListener('pointerleave', () => { hover = -1; hoverC = -1; hooks.onHover?.(-1); });

  return {
    setRecord(r) {
      rec = r;
      lastT = -1;
      lastN = -1;
      follow = -1;
      heading.length = 0; bank.length = 0; bankT.length = 0;
      mounts.length = 0;
      for (const tm of tModels.values()) { tm.list.length = 0; if (tm.mesh) tm.mesh.count = 0; }
      for (const m of models.values()) {
        if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); }
        for (const x of Object.values(m.hfx || {})) { scene.remove(x); x.dispose(); }
        ckDrop(m);
      }
      models.clear();
      ORG[0] = ORG[1] = ORG[2] = 0;
      followAt = null;
      cels.set(r?.cel);
      shl.set(r?.cel);
      flare?.set(r?.cel);
      const st = cels.sunType();
      if (st != null) { const c = sunLight(st); sun.color.setRGB(c[0], c[1], c[2]); }
      else { sunDir.set(0.6, 0.5, 0.35); sky.material.uniforms.sun.value.set(0.6, 0.5, 0.35).normalize(); }
    },
    draw,
    render() {
      watchPerf();
      const now = performance.now(), dt = Math.min(0.1, Math.max(0.001, lastRender ? (now - lastRender) / 1000 : 1 / 60));
      lastRender = now;
      const jf = jumpFrame(dt);   // 过导管：镜头由过场接管
      if (!jf) { controls.update(); dynFov(); }
      sky.position.copy(camera.position); bg.position.copy(camera.position); stars?.update(now / 1000);
      if (dust) {
        // 自己船的速度（米 / 秒）：记录里上一步到这一刻的位置差（客户端速度元素用的是球的当前速度；实时对战的记录只到当前这一步，不能往后取）
        const si = hooks.self?.() ?? -1, d = si >= 0 ? drawn[si] : null;
        dustV[0] = dustV[1] = dustV[2] = 0;
        const t0 = rec ? Math.max(0, lastDrawT - rec.dt) : 0, h = lastDrawT - t0;
        if (d?.alive && h > 0) {
          const p = posAt(si, t0, dustP), q = posAt(si, lastDrawT, dustQ);
          if (p && q) { dustV[0] = (q.x - p.x) / KM / h; dustV[1] = (q.y - p.y) / KM / h; dustV[2] = (q.z - p.z) / KM / h; }
        }
        dustC[0] = camera.position.x / KM + ORG[0]; dustC[1] = camera.position.y / KM + ORG[1]; dustC[2] = camera.position.z / KM + ORG[2];
        dust.update(dustC, dustV, dt, Boolean(d?.alive) && !jf && (follow < 0 || follow === si));
      }
      if (rec?.cel?.length) celUpdate();
      const shook = warpFrame(now, dt, Boolean(jf));
      const hi = post && level === 'high';
      fitShadow(hi);
      if (jump?.f) jump.run.update(jump.f.t, camera, jump.ship, hi);
      flare?.update(ORG, !hi); envFx?.update(camera, ORG, now / 1000, controls.target);
      if (hi && refl && skyState !== 'loading') setEnvTex(refl.update(scene, camera, [brPts, flPts, ringPts, tacDisc], reflBefore, reflAfter)); else setEnvTex(envStatic);
      // 船体灯（sim-lights.js）：只在高画质档
      if (hi) { renderer.getDrawingBufferSize(ssaoV); lightList.length = 0; for (const mm of [models, dModels]) for (const m of mm.values()) if (m.state === 'ok' && m.mesh && m.def.lights) lightList.push(m); updateShipLights(lightList, camera, ssaoV.x, ssaoV.y, performance.now() / 1000); } else clearShipLights();
      if (hi && ssao) { renderer.getDrawingBufferSize(ssaoV); ssao.run(scene, camera, ssaoV.x, ssaoV.y); } else ssao?.off();
      if (hi) post.render(scene, camera, [tunnel?.distScene, ckDist, jumpFx?.distScene], flare?.draw); else { renderer.setRenderTarget(null); renderer.render(scene, camera); flare?.draw(); }
      if (shook) camera.quaternion.copy(shakeQ);
      drawLabels();
      nativeOut();
    },
    // 原生引擎：sink = { frame, ships, scene }（native-engine.js），null 断开；nativeScene() 给原生引擎用的星系场景
    setNative(sink) { nativeSink = sink; nativeSig = ''; nativeT = -1; nativeOpen.clear(); },
    nativeScene() {
      const id = opt.skybox ? String(opt.skybox).replace(/\/+$/, '').split('/').pop() : '';
      return /^[a-z0-9_]+$/i.test(id) ? `res:/dx9/scene/universe/${id.toLowerCase()}_cube.red` : null;
    },
    // 深渊口袋之间过导管（客户端 effects.JumpOutAbyssalBetween）：ci = rec.cel 里导管的序号；
    //   cb.onMid()：ApplyDestinationScene 那一刻（3.7 秒）；cb.onEnd()：Stop 那一刻（5 秒，船重新显示）；隧道留到 7.5 秒，镜头 7.6 秒前后交还
    //   返回 { cancel() }：立刻结束过场（不再调回调）
    abyssJump(ci, cb = {}) {
      const c = rec?.cel?.[ci];
      if (!c?.pos || !opt.fx) return { cancel() {} };
      endJump();
      jumpFx ||= createJumpFx(scene, `${opt.fx}jump/`);
      // 导管：模型包围球半径（舰船索引）；朝向照 sim-station.js 摆模型的 yaw（名字 | 类型 的 FNV 散列）
      const gateR = shipIndex?.models?.[shipIndex?.cel?.[c.type]]?.r || c.radius || 5000;
      let h = 2166136261;
      const hk = `${c.name}|${c.type}`;
      for (let k = 0; k < hk.length; k++) h = Math.imul(h ^ hk.charCodeAt(k), 16777619);
      const yaw = ((h >>> 0) / 4294967296) * Math.PI * 2;
      const si = hooks.self?.() ?? -1;
      const w = (v) => [v.x / KM + ORG[0], v.y / KM + ORG[1], v.z / KM + ORG[2]];
      const fov0 = THREE.MathUtils.degToRad(camera.fov);
      const seq = createJumpSequence({ gate: c.pos, gateYaw: yaw, gateR, at0: w(controls.target), eye0: w(camera.position), fov0, fovTarget: opt.fov || fov0, onMid: cb.onMid, onEnd: cb.onEnd });
      const run = jumpFx.run({ gateYaw: yaw, shipR: si >= 0 && rec.units[si] ? radiusOf(si) : 0.05 });
      jump = { seq, run, hide: -1, ctl: controls.enabled, handed: false, f: null, ship: null };
      controls.enabled = false;
      const me = jump;
      return { cancel() { if (jump === me) endJump(); } };
    },
    setLabels(on) { labels = on; drawLabels(); },
    // 深渊环境特效：list 见 sim-env.js（边界泡 / 云团 / 天气云层）；空数组清掉
    // 区域调色：GRADES 的键（amarr / caldari / gallente / minmatar / concord）或 null
    setGrade(k) { post?.setGrade(GRADES[k] || null); },
    setStarfield(sf) { stars?.set(sf?.seed || 0, sf ? starCount(sf.sec) : 0); },
    setEnvFx(list) { (envFx ||= createEnvFx(scene, `${opt.fx || 'assets/eveui/fx/'}env/`)).set(list); },
    // 自己在哪一方（匹配对战里可能在 B 方）：自己这方画蓝色、对面画红色
    setOwnSide(s) { ownSide = s === 'B' ? 'B' : 'A'; },
    setDirector(on) { director = on; dirLast = 0; if (on) { follow = -1; flyTo = null; } },
    setQuality(q) { quality = q; perf.slow = 0; perf.t0 = 0; applyLevel(q === 'low' ? 'low' : 'high'); },
    // 选落点：opt = { side, color: '#rrggbb', label, done(pos) }；null 取消
    setPlacing(opt) { placing = opt; el.style.cursor = opt ? 'crosshair' : ''; if (opt) { hover = -1; hooks.onHover?.(-1); } },
    resetCamera: fit,
    // 镜头转到「从注视点看向 p（米）」的方向（距离不变）
    lookToward(p) {
      vA.set((p[0] - ORG[0]) * KM, (p[1] - ORG[1]) * KM, (p[2] - ORG[2]) * KM).sub(controls.target).normalize();
      const d = camera.position.distanceTo(controls.target);
      camera.position.copy(controls.target).addScaledVector(vA, -d);
      camera.lookAt(controls.target);
    },
    follow: setFollow,
    screenOf,
    dirAt,
    // 拾取射线（米）：鼠标位置 → { o: 镜头位置, d: 单位方向 }
    rayAt(cx, cy) { const d = dirAt(cx, cy); if (!d) return null; return { o: [camera.position.x / KM + ORG[0], camera.position.y / KM + ORG[1], camera.position.z / KM + ORG[2]], d }; },
    // 世界坐标（米）→ 画布 CSS 像素；在镜头后面返回 null
    project(p) {
      vA.set((p[0] - ORG[0]) * KM, (p[1] - ORG[1]) * KM, (p[2] - ORG[2]) * KM).sub(camera.position);
      const l = vA.length();
      if (l > 15000) vA.multiplyScalar(15000 / l);   // 远处（天体）：只要方向
      vA.add(camera.position).project(camera); if (vA.z > 1) return null; return [(vA.x + 1) / 2 * host.clientWidth, (1 - vA.y) / 2 * host.clientHeight]; },
    // 同上，但在镜头后面 / 画面外时也给一个方向：镜头后面的点把方向翻过来推到画面外（练习的高亮圈贴边用）
    projectEdge(p) {
      vA.set((p[0] - ORG[0]) * KM, (p[1] - ORG[1]) * KM, (p[2] - ORG[2]) * KM).sub(camera.position);
      const l = vA.length();
      if (l > 15000) vA.multiplyScalar(15000 / l);
      vA.add(camera.position).project(camera);
      let x = vA.x, y = vA.y;
      if (vA.z > 1) { const m = Math.max(Math.abs(x), Math.abs(y)) || 1; x = -x / m * 2; y = -y / m * 2; }
      return [(x + 1) / 2 * host.clientWidth, (1 - y) / 2 * host.clientHeight]; },
    // 第 i 艘船这一帧画在哪（米）
    drawnPos(i) { const p = drawn[i]; return p ? [p.x / KM + ORG[0], p.y / KM + ORG[1], p.z / KM + ORG[2]] : null; },
    // 镜头相对注视点：dir = 单位方向，d = 距离（千米）（练习：看玩家有没有转动、缩放镜头）
    camInfo() { const v = vA.copy(camera.position).sub(controls.target), d = v.length() || 1; return { d, dir: [v.x / d, v.y / d, v.z / d] }; },
    // 镜头离跟随的船的距离（千米）
    zoomTo(km) { const d = vA.copy(camera.position).sub(controls.target); camera.position.copy(controls.target).addScaledVector(d.normalize(), km); },
    following: () => follow,
    track(i) { track = i; },
    tracking: () => track,
    setTactical(cfg) { tac = cfg || null; drawTac(); },
    tacLabels,
    // 加载进度：舰船索引、模型（已完成 / 总数，加载失败也算完成）、星空、特效贴图
    loadState() {
      let done = 0;
      for (const m of models.values()) if (m.state !== 'loading') done++;
      return { index: Boolean(shipIndex), done, total: models.size, sky: skyState !== 'loading', fx: fx.ready() };
    },
    dispose() { endJump(); jumpFx?.dispose(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); fx.dispose(); envFx?.dispose(); ssao?.dispose(); refl?.dispose(); stars?.dispose(); dust?.dispose(); for (const m of models.values()) m.mesh?.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove(); lbl.remove(); }
  };
}
