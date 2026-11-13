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
import { loadShipIndex, loadShipModel, bracketAtlas, BRACKETS, DRONE_BRACKETS } from './sim-ships.js?v=v10';
import { createFx } from './sim-fx.js?v=v35';
import { createCelestials, sunLight } from './sim-cel.js?v=5';
import { createWarpTunnel } from './sim-warp.js?v=3';

const COLOR = { A: new THREE.Color(0x5b9bff), B: new THREE.Color(0xff4b3e) };
const WRECK = new THREE.Color(0x8a9099);
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
// 泛光：逐级减半降采样 6 次（13 点滤波）→ 每级横向、纵向高斯模糊，半径 = 该级最长边 × sizeScale × stepNSize × 0.01 →
//       从最粗一级往上加，每级乘 stepNTint × brightness ÷ 6。
// 合成：场景解码成线性；泛光过 Uncharted2 曲线后加上去；乘曝光；再过 Uncharted2：U(2c) ÷ U(W)；sRGB 编码；加抖动。
// 数值是 Tr2PPBloomEffect / Tr2PPTonemappingEffect 的默认值（EVE 只走 Uncharted2 分支，default postprocess.black 里的 slope / toe 等是 ACES 参数、EVE 不用）。
// 动态曝光（Tr2PostProcessRenderer::RenderDynamicExposure，照 ccpwgl2 的 WebGL 实现）：
//   每个像素 sRGB 解码、Rec.709 亮度，按 ln(亮度) 在 ln(minLuminance)~ln(maxLuminance) 间分 64 桶 →
//   取像素数 0.9 / 0.98 分位上的亮度（桶内插值），平均 = 两者中点；scale = clamp(0.5 ÷ 平均, 2^minExposure, 2^maxExposure)，目标 = 0.5 ÷ scale；
//   在平方根空间按 1 − e^(−速度 × dt) 追目标（变亮 increaseSpeed，变暗 decreaseSpeed）；
//   合成时曝光 = middleValue ÷ mix(0.5, 适应值, influence)（tonemapping 动态曝光分支的反汇编）。
//   需要浮点混合（EXT_float_blend）；没有时曝光固定为 1。
const BLOOM = { sizeScale: 4, brightness: 0.2, size: [0.3, 1, 2, 10, 30, 64], tint: [0.3465, 0.138, 0.1176, 0.066, 0.066, 0.061] };
const EXPO = { influence: 1, middleValue: 0.55, minExposure: -3.7, maxExposure: 10, minLuminance: 0.4649, maxLuminance: 10, minBrightness: 0.9, maxBrightness: 0.98, increaseSpeed: 2, decreaseSpeed: 1.5 };   // Tr2PPDynamicExposureEffect 类默认值
const TONE = { A: 0.125, B: 0.25, C: 0.1, D: 0.15, E: 0.021, F: 0.3, W: 2.5 };   // shoulderStrength、linearStrength、linearAngle、toeStrength、toeNumerator、toeDenominator、whiteScale
function createPost(renderer) {
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return null;
  const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const mk = (uniforms, fs) => new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const qs = new THREE.Scene(); qs.add(quad);
  const qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // postprocess/downsample（LUNINANCE_PRESERVE_OFF）：中间 4 点 ×0.125，外围 4 组 2×2 各 ×0.03125
  const down = mk({ tex: { value: null }, inv: { value: new THREE.Vector2() } }, `uniform sampler2D tex; uniform vec2 inv; varying vec2 vUv;
    vec3 T(float x, float y) { return texture2D(tex, vUv + vec2(x, y) * inv).rgb; }
    void main() {
      vec3 c = T(0.0, 0.0), a = T(-2.0, -2.0), b = T(0.0, -2.0), d = T(2.0, -2.0), e = T(-2.0, 0.0), f = T(2.0, 0.0), g = T(-2.0, 2.0), h = T(0.0, 2.0), i = T(2.0, 2.0);
      vec3 o = (T(-1.0, -1.0) + T(1.0, -1.0) + T(-1.0, 1.0) + T(1.0, 1.0)) * 0.125;
      o += ((a + b + e + c) + (d + b + c + f) + (g + e + c + h) + (i + f + h + c)) * 0.03125;
      gl_FragColor = vec4(o, 1.0);
    }`);
  // postprocess/upsample：高斯多点采样；第二遍（纵向）= 模糊结果 × 权重 + 更粗一级
  const up = mk({ tex: { value: null }, last: { value: null }, dir: { value: new THREE.Vector2() }, taps: { value: new Float32Array(256) }, count: { value: 0 }, tint: { value: new THREE.Vector3() }, second: { value: 0 } },
    `uniform sampler2D tex, last; uniform vec2 dir; uniform vec4 taps[64]; uniform int count; uniform vec3 tint; uniform float second; varying vec2 vUv;
    void main() {
      vec3 o = vec3(0.0);
      for (int k = 0; k < 64; k++) {
        if (k >= count) break;
        vec4 t = taps[k];
        o += texture2D(tex, vUv + dir * t.y).rgb * t.x + texture2D(tex, vUv + dir * t.w).rgb * t.z;
      }
      gl_FragColor = vec4(second > 0.5 ? o * tint + texture2D(last, vUv).rgb : o, 1.0);
    }`);
  // 扭曲缓冲（跃迁隧道的 warptunneldistortion 等写入的屏幕偏移，单位像素）：合成时按它挪动场景的采样位置
  const tone = mk({ scene: { value: null }, bloom: { value: null }, expo: { value: null }, useExpo: { value: 0 }, useBloom: { value: 1 }, dist: { value: null }, useDist: { value: 0 }, inv: { value: new THREE.Vector2() } },
    `uniform sampler2D scene, bloom, expo, dist; uniform float useExpo, useBloom, useDist; uniform vec2 inv; varying vec2 vUv;
    const float A = ${TONE.A.toFixed(4)}, B = ${TONE.B.toFixed(4)}, C = ${TONE.C.toFixed(4)}, D = ${TONE.D.toFixed(4)}, E = ${TONE.E.toFixed(4)}, F = ${TONE.F.toFixed(4)}, W = ${TONE.W.toFixed(4)};
    vec3 U(vec3 x) { return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F; }
    void main() {
      vec2 uv = useDist > 0.5 ? vUv + texture2D(dist, vUv).xy * inv : vUv;
      vec3 c = texture2D(scene, uv).rgb;
      c = mix(pow(abs(c + 0.055) * 0.947867, vec3(2.4)), c * 0.077399, vec3(lessThan(c, vec3(0.04045))));
      float wInv = 1.0 / U(vec3(W)).x;
      vec3 b = texture2D(bloom, vUv).rgb * useBloom;
      float exposure = useExpo > 0.5 ? ${EXPO.middleValue.toFixed(4)} / mix(0.5, texture2D(expo, vec2(0.0625, 0.5)).r, ${EXPO.influence.toFixed(4)}) : 1.0;
      c = (c + max(U(2.0 * b), 0.0) * wInv) * exposure;
      c = max(U(2.0 * max(c, 0.0)), 0.0) * wInv;
      c = mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.003131))));
      c += fract(dot(gl_FragCoord.xy, vec2(0.754878, 0.569840))) * 0.003922 - 0.001961;
      gl_FragColor = vec4(c, 1.0);
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
  let sceneRT = null, distRT = null, mips = [], ups = [], size = '';
  const rt = (w, h, o = {}) => new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o });
  function resize(w, h) {
    if (`${w}x${h}` === size) return;
    size = `${w}x${h}`;
    for (const t of [sceneRT, distRT, ...mips, ...ups]) t?.dispose();
    sceneRT = rt(w, h, { depthBuffer: true, samples: 4 });
    distRT = rt(w, h);
    // 标准材质往这个缓冲里写 sRGB 编码值（three 只对 XR 渲染目标按贴图色彩空间输出）
    sceneRT.isXRRenderTarget = true; sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
    mips = []; ups = [];
    let k = 0.5;
    for (let i = 0; i < 6; i++, k *= 0.5) {
      if (Math.trunc(Math.min(w, h) * k) === 0) break;
      mips.push(rt(Math.trunc(w * k), Math.trunc(h * k))); ups.push(rt(Math.trunc(w * k), Math.trunc(h * k)));
    }
  }
  // GaussianData.calculateGaussianPassParameters：每两个相邻像素并成一次线性采样
  function gauss(radius, norm, out) {
    const R = Math.min(Math.max(radius, 0.0001), 127), ir = Math.ceil(R);
    const nd = (x) => Math.exp(-Math.PI * 5 * (x * x / (R * R)));
    const t = [];
    let sum = 0;
    for (let i = -ir; i <= ir; i += 2) {
      const w = nd(i), ow = i === ir ? 0 : nd(i + 1), sw = w + ow;
      if (sw === 0) continue;
      const off = (i + ow / sw) * norm;
      sum += sw;
      if (off < -1 || off > 1) continue;
      t.push(sw, off);
    }
    if ((t.length / 2) % 2) t.push(0, 0);
    out.fill(0);
    for (let k = 0; k < t.length && k < 256; k += 2) { out[k] = t[k] / sum; out[k + 1] = t[k + 1]; }
    return Math.min(64, t.length / 4);
  }
  const draw = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(qs, qc); };
  // distScene：有可见内容时先画进扭曲缓冲（清成 0，加色叠加）
  function render(scene, camera, distScene) {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    resize(v.x, v.y);
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    const useDist = Boolean(distScene?.children.some((o) => o.visible));
    if (useDist) {
      const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
      renderer.setRenderTarget(distRT);
      renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.render(distScene, camera);
      renderer.setClearColor(cc, ca);
    }
    tone.uniforms.dist.value = useDist ? distRT.texture : blackTex; tone.uniforms.useDist.value = useDist ? 1 : 0;
    tone.uniforms.inv.value.set(1 / v.x, 1 / v.y);
    // 降采样
    let src = sceneRT;
    for (const m of mips) { down.uniforms.tex.value = src.texture; down.uniforms.inv.value.set(1 / src.width, 1 / src.height); draw(down, m); src = m; }
    // 升采样：先全部横向，再从粗到细纵向
    const U = up.uniforms, n = mips.length, rad = (i) => Math.max(mips[i].width, mips[i].height) * BLOOM.sizeScale * BLOOM.size[i] * 0.01;
    for (let i = n - 1; i >= 0; i--) {
      U.tex.value = mips[i].texture; U.second.value = 0; U.dir.value.set(1, 0);
      U.count.value = gauss(rad(i), 1 / mips[i].width, U.taps.value);
      draw(up, ups[i]);
    }
    let last = null;
    for (let i = n - 1; i >= 0; i--) {
      U.tex.value = ups[i].texture; U.last.value = last ? last.texture : null; U.second.value = 1; U.dir.value.set(0, 1);
      U.count.value = gauss(rad(i), 1 / mips[i].height, U.taps.value);
      U.tint.value.setScalar(last || i === n - 1 ? BLOOM.tint[i] * BLOOM.brightness / 6 : 0);
      if (!last) U.last.value = blackTex;
      draw(up, mips[i]);
      last = mips[i];
    }
    tone.uniforms.scene.value = sceneRT.texture; tone.uniforms.bloom.value = last ? last.texture : blackTex; tone.uniforms.useBloom.value = last ? 1 : 0;
    let ex = null;
    try { ex = expo?.run(sceneRT) || null; } catch (e) { console.warn('dynamic exposure', e); }
    tone.uniforms.expo.value = ex || blackTex; tone.uniforms.useExpo.value = ex ? 1 : 0;
    draw(tone, null);
  }
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blackTex.needsUpdate = true;
  return { render, dispose() { for (const t of [sceneRT, distRT, ...mips, ...ups]) t?.dispose(); expo?.dispose(); } };
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
  const post = opt.post ? createPost(renderer) : null;
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
  sun.position.set(0.6, 0.5, 0.35);
  const amb = new THREE.AmbientLight(0x8090b0, 0.25);
  scene.add(sun, amb);
  // 天体（驾驶模拟，rec.cel）：恒星、行星、卫星；有恒星时方向光改成真实的恒星方向
  const cels = createCelestials(scene, { load: (k) => loadModel(k), env: () => [env, envI] });   // 空间站 / 星门模型用舰船的加载器和环境反射
  // 跃迁隧道（驾驶模拟：hooks.warpFx() 给出自己船的跃迁状态）
  const tunnel = opt.fx && hooks.warpFx ? createWarpTunnel(scene, `${opt.fx}warp/`) : null;
  let shakeN = 0;
  const shakeQ = new THREE.Quaternion(), shakeE = new THREE.Euler(), shakeR = new THREE.Quaternion();
  function warpFrame() {
    const ws = tunnel ? hooks.warpFx() : null;
    tunnel?.update(camera, ws);
    // 镜头抖动（Warp.py ShakeCamera）：每秒重发一次「0.5 秒升到 2 × 强度、5 秒降到 0」→ 近似为平滑跟随 2 × 强度；
    // 客户端 shaker 的噪声频率和幅度换算没拿到，这里按每单位 0.01 弧度的平滑噪声（推断）
    shakeN += ((ws ? 2 * ws.shake : 0) - shakeN) * 0.08;
    if (shakeN < 1e-4) return false;
    const t = performance.now() / 1000, k = shakeN * 0.01;
    shakeE.set(k * (Math.sin(t * 57.1) * 0.6 + Math.sin(t * 23.3 + 1.7) * 0.4), k * (Math.sin(t * 61.7 + 0.5) * 0.6 + Math.sin(t * 19.9 + 2.9) * 0.4), 0);
    shakeQ.copy(camera.quaternion);
    camera.quaternion.multiply(shakeR.setFromEuler(shakeE));
    return true;
  }
  function celUpdate() {
    const d = cels.update(camera, ORG);
    if (d) { sun.position.copy(d); sky.material.uniforms.sun.value.copy(d); }
  }
  let env = null, envI = 1;   // 环境反射贴图、强度（场景的 reflectionIntensity）
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
    pm.dispose();
  }

  // 远处的星空（用游戏星空贴图时不画）
  // STARS：星点开关。游戏星空的三层平铺星点（StarMap）和这里的兜底星点看着不对，先关掉，只留星云
  const STARS = false;
  const starPts = [];
  if (STARS) {
    const n = 1500, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8000 + Math.random() * 6000);
      p.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8090a8, size: 1.5, sizeAttenuation: false }));
    starPts.push(pts);
    scene.add(pts);
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
  if (opt.skybox) {
    const dir = opt.skybox.replace(/\/?$/, '/');
    const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => f + '.webp');
    const cube = (path, cs) => new Promise((ok, no) => new THREE.CubeTextureLoader().setPath(path).load(faces, (t) => { t.colorSpace = cs; ok(t); }, undefined, no));
    const tex2d = (url) => new Promise((ok, no) => new THREE.TextureLoader().load(url, ok, undefined, no));
    Promise.all([
      cube(dir, THREE.SRGBColorSpace), cube(dir + 'refl/', THREE.NoColorSpace), tex2d(dir + '../stars.webp'),
      fetch(dir + 'scene.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([neb, refl, star, sc]) => {
      star.wrapS = star.wrapT = THREE.RepeatWrapping;
      star.colorSpace = THREE.NoColorSpace;
      star.anisotropy = renderer.capabilities.getMaxAnisotropy();
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
        // 第 2、3 层星点的平移量（Layer 2 / 3 x、y offset）场景文件里没写，取 0
        fragmentShader: `uniform samplerCube neb, alpha; uniform sampler2D star; uniform vec4 sp, ab1, ab2; uniform vec3 tint; varying vec3 vD;
          void main() {
            vec3 d = vec3(-vD.x, vD.y, vD.z);   // 和 three 的立方体背景同向
            vec3 a = abs(d);
            float ma = max(max(a.x, a.y), a.z);
            vec3 sel = vec3(greaterThanEqual(a, vec3(ma)));
            vec2 uv = (vec2(dot(sel, vec3(d.z, -d.z, d.x)), dot(sel, vec3(d.y, d.x, -d.y))) / ma + 1.0) * 0.5;
            vec3 s1 = texture2D(star, uv * sp.x).rgb, s2 = texture2D(star, uv * sp.y).rgb, s3 = texture2D(star, uv * sp.z).rgb;
            float m = textureCube(alpha, d).a;
            vec2 t = 1.0 - clamp((vec2(m) - ab1.xz) / (ab1.yw - ab1.xz), 0.0, 1.0);
            float t3 = 1.0 - clamp((m - ab2.x) / (ab2.y - ab2.x), 0.0, 1.0);
            vec3 c = max((${STARS ? 'sp.w' : '0.0'} * (s1 * t.x + s2 * t.y + s3 * t3) + textureCube(neb, d).rgb) * tint, 0.0);
            gl_FragColor = vec4(mix(1.055 * pow(c, vec3(0.416667)) - 0.055, c * 12.92, vec3(lessThan(c, vec3(0.0031308)))), 1.0);
          }`,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
      });
      bg.visible = true;
      skyCube = neb;
      const pm = new THREE.PMREMGenerator(renderer);
      env = pm.fromCubemap(refl).texture;
      tunnel?.setEnv(refl);
      pm.dispose();
      envI = sc.reflectionIntensity ?? 1;
      for (const set of [models, tModels, dModels]) for (const m of set.values()) for (const mt of m.def?.materials || []) { mt.envMap = env; mt.envMapIntensity = envI; mt.needsUpdate = true; }
      amb.intensity = 0;   // quadv5 没有环境光常量，暗面只靠环境立方体
      sky.visible = false;
      for (const p of starPts) p.visible = false;
      skyState = 'ok';
    }).catch(() => { skyState = 'fail'; });
  }

  // 总览图标：屏幕空间的点精灵，图集里按类别取图
  const brGeo = new THREE.BufferGeometry();
  let brCap = 0;
  const brMat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: null }, grid: { value: new THREE.Vector2(brkOf ? BR_COLS : BRACKETS.length, brkOf ? BR_COLS : 1) }, size: { value: iconPx * dpr } },
    vertexShader: `attribute vec4 tint; attribute float icon; varying vec4 vTint; varying float vIcon; uniform float size;
      void main() { vTint = tint; vIcon = icon; gl_PointSize = size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D atlas; uniform vec2 grid; varying vec4 vTint; varying float vIcon;
      void main() { vec4 t = texture2D(atlas, (vec2(mod(vIcon, grid.x), floor(vIcon / grid.x)) + gl_PointCoord) / grid); if (t.a * vTint.a < 0.02) discard; gl_FragColor = vec4(t.rgb * vTint.rgb, t.a * vTint.a); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const brPts = new THREE.Points(brGeo, brMat);
  brPts.frustumCulled = false;
  brPts.renderOrder = 5;
  brPts.visible = false;
  scene.add(brPts);
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
  const mounts = [];           // 每艘船：[{ k, mat（船体局部，已镜像到 three 坐标）, ri（装备序号）}]
  const MX = new THREE.Matrix4().makeScale(-1, 1, 1);
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
        for (const [nm, a] of L) if (parseInt(nm, 10) === n) out.push({ k, mat: MX.clone().multiply(new THREE.Matrix4().fromArray(a)).multiply(MX), ri });
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
    out.set(-c[0], c[1], c[2]).applyMatrix4(mt.mat).multiplyScalar(KM);
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
  // 隐形装置（effects.Cloak → fisfx/cloaking/cloaking.black，EveMeshOverlayEffect）。客户端曲线：
  //   CloakAmount 0 → 1.13（4.9 秒，线性）绑到船的 clipSphereFactor（从一个损伤定位点开始溶解）；FresnelTweaker 0.35 → 1.3（3.01 秒）→ 0.35（6 秒，Hermite）绑到叠加层 F.y
  //   解除隐形（effects.Uncloak）= 同一组曲线倒着放（scale −1，从 6 秒开始）；别人的船去掉加色 / 扭曲层（只剩溶解），自己的船保留
  // 这里简化：溶解没做（CloakAmount ≥ 1 时整船不画，之前照常画）；fxcloakv5 的六边形 / 噪声层、扭曲层、过渡层没移植，
  //   只画 CloakWaves_widefresnel 的菲涅尔（F = 16, 曲线, 0.25；FxColor）+ CloakColor 的底色，菲涅尔公式借用上面的 skinned_fxv3
  HFX.ck = { ghost: true, len: 6 };
  const CK_FRES = [[0, 0.35, 0, 0.009, 2], [3.01, 1.3, -0.028, -0.028, 2], [6, 0.35, -0.012, 0, 2]];
  let ghostMat = null;
  function cloakMat() {
    return (ghostMat ||= new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: `varying vec3 vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          mat4 im = modelMatrix * instanceMatrix;
          vec4 wp = im * vec4(position, 1.0);
          vN = mat3(im) * normal; vV = normalize(cameraPosition - wp.xyz);
          vCol = vec3(0.0);
          #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
          #endif
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `varying vec3 vN, vV, vCol;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float d = clamp(dot(vV, normalize(vN)) - 0.25, 0.0, 1.0);
          float fres = pow(1.0 - d, 16.0) * vCol.x;
          gl_FragColor = vec4(fres * vec3(0.4275, 0.4627, 0.4824) + vec3(0.0118, 0.0196, 0.0235), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  }
  // 别人跃迁时船模型藏起来（WarpFlashOut 起跳闪光时隐藏，WarpFlashIn 落地闪光时再出现；短于 4 万 km 的跃迁不藏）
  const WARP_HID = { hidden: true, fy: 0 };
  let warpEv = null, warpEvN = -1, warpEvR = null;
  function warpHidden(i, t) {
    const ev = rec.events || [];
    if (warpEvR !== rec || warpEvN !== ev.length) { warpEvR = rec; warpEvN = ev.length; warpEv = ev.filter((e) => e.kind === 'warp' && e.tOut != null && e.D >= 4e7); }
    if (!warpEv.length || i === (hooks.self?.() ?? -1)) return false;
    for (const e of warpEv) if (e.unit === i && t >= e.tOut && t < e.tIn) return true;
    return false;
  }
  // 第 i 艘船的隐形状态：{ hidden（整船不画）, fy（菲涅尔曲线值）}；没开 / 早已解除 → null
  function cloakAt(i, t) {
    const rack = rec.units[i].rack || [];
    const j = rack.findIndex((x) => x.hfx === 'ck');
    if (j < 0 || j >= 32) return null;
    const F = rec.frames, dt = rec.dt, k = Math.max(0, Math.min(F.length - 1, Math.floor(t / dt))), bitm = 1 << j;
    let a;
    if (F[k].act?.[i] & bitm) a = hfxAge(i, j, t, { loop: true, len: 1e9 });
    else {
      let b = 0;
      const n = Math.ceil(6 / dt) + 1;
      while (b < n && F[k - b] && !(F[k - b].act?.[i] & bitm)) b++;
      if (b >= n || !F[k - b]) return null;
      a = 6 - (t - F[k - b].t);   // 倒着放
      if (a <= 0) return null;
    }
    return { hidden: Math.min(1.13, 1.13 * a / 4.9) >= 1, fy: curveAt(CK_FRES, Math.min(a, 6)) };
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
    if (HFX[base]?.ghost) return cloakMat();   // 每个模型一份（模型中心 / 半径不同）
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
    if (m.hfx) for (const x of Object.values(m.hfx)) { scene.remove(x); x.dispose(); if (x.material !== ghostMat && !Object.values(hfxMats).includes(x.material)) x.material.dispose(); }
    m.hfx = {};
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
  // 开火特效；P 是给特效模块的查询接口
  const fx = createFx(scene, renderer, { tex: opt.fx });
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
        tm.mesh.frustumCulled = false;
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
    // 护盾椭球（模型的 se：船体坐标的中心、半轴，米；几何镜像了 X）→ 世界矩阵（千米）
    shell: (i, out) => {
      const se = models.get(keyOf(i))?.def?.se, d = drawn[i];
      if (!se || !d) return null;
      shT.position.set(-se[0], se[1], se[2]).applyQuaternion(heading[i] || qI).multiplyScalar(KM);
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
    ringMat.uniforms.dpr.value = dpr;
    sky.visible = l === 'high' && !skyCube;
    lastSize = '';
    resize();
  }
  // opt.fov：固定视角（弧度，客户端镜头动态移动关着时 = default_fov 1.0）；opt.dynFov：按距离变
  function dynFov() {
    if (!opt.dynFov && !opt.fov) return;
    const prop = Math.max(0, Math.min(1, camera.position.distanceTo(controls.target) * 1000 / 800000));
    const fov = THREE.MathUtils.radToDeg(opt.dynFov ? 0.55 + prop ** 0.35 * 0.55 : opt.fov);
    if (Math.abs(fov - camera.fov) < 1e-3) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
    bstMat.uniforms.scale.value = host.clientHeight * dpr / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
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
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
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
      if (alive && q.distanceToSquared(p) > 1e-12) {
        tmp.position.copy(p); tmp.lookAt(q); heading[i].copy(tmp.quaternion);
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
    const white = new THREE.Color(1, 1, 1), dark = new THREE.Color(0.22, 0.2, 0.2);
    const bp = [], bc = [], bs = [], fl = [], gw = [];
    const hfxNow = performance.now() / 1000;
    for (const m of models.values()) {
      if (m.state !== 'ok' || !m.mesh) continue;
      let c = 0;
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
        const ck = d.alive && !m.wreck ? (warpHidden(i, t) ? WARP_HID : cloakAt(i, t)) : null;
        if (!ck?.hidden) {
          m.mesh.setMatrixAt(c, tmp.matrix);
          m.mesh.setColorAt(c, d.alive || m.wreck ? white : dark);
          c++;
        }
        if (d.alive && !m.wreck && !ck?.hidden) for (const mt of mountsOf(i, m.def)) {
          const tm = tModels.get(mt.k);
          if (tm?.state === 'ok') tm.list.push(new THREE.Matrix4().multiplyMatrices(tmp.matrix, mt.mat));
        }
        // 船身叠加特效：同一种特效多件装备取最亮的
        if (d.alive && ck !== WARP_HID) {
          const rack = rec.units[i].rack || [];
          const best = {};
          for (let j = 0; j < rack.length && j < 32; j++) {
            const kind = rack[j].hfx;
            if (!kind || !HFX[kind]) continue;
            const H = HFX[kind];
            if (H.ghost) {   // 隐形：亮度曲线值放进实例颜色
              if (ck) best[kind] = new THREE.Color(ck.fy, 0, 0);
              continue;
            }
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
        if (d.alive && !ck?.hidden) {
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
              mBst.makeScale(b[3], b[3], b[4] * zk).setPosition(-b[0], b[1], b[2]);
              mBst2.multiplyMatrices(tmp.matrix, mBst);
              fl.push(...mBst2.elements, ...(B.a0 || BST_DEF.a0), ...(B.a1 || BST_DEF.a1), ...(B.fq || BST_DEF.fq), ...((warping && B.wc0) || B.c0 || BST_DEF.c0), (i * 7.13 + b[0]) % 1, b[5] || 0, I);
              vA.set(-b[0], b[1], b[2]).applyMatrix4(tmp.matrix);
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
    const ip = [], it = [], ii = [];
    // 天体图标（灰白，按总览页签过滤：hooks.celShown）
    celUpdate();
    if (brkOf) for (let c = 0; c < cels.count(); c++) {
      const p = cels.pos(c), cc = rec.cel[c];
      if (!p || (hooks.celShown && !hooks.celShown(c))) continue;
      const k = brSlot(CEL_BRK[cc.group] || CEL_BRK[7]);
      if (k < 0) continue;
      const on = c === (opt.selC ?? -1) || c === hoverC;
      ip.push(p.x, p.y, p.z); it.push(on ? 1 : 0.78, on ? 1 : 0.8, on ? 1 : 0.84, on ? 1 : 0.8); ii.push(k);
    }
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d) continue;
      vA.set(d.x, d.y, d.z);
      const px = radiusOf(i) / kmPerPx(vA);
      const hasModel = models.get(keyOf(i))?.state === 'ok';
      const a = hasModel && !brkOf ? Math.max(0, Math.min(1, 1 - (px - 14) / 26)) : 1;
      if (a <= 0 && opt.sel !== i) continue;
      const ic = d.alive ? iconOf(i) : wreckIcon();
      if (ic < 0) continue;
      const c = d.alive ? COLOR[sideOf(rec.units[i].side)] : WRECK;
      const hi = opt.sel === i ? 1.35 : 1;
      ip.push(d.x, d.y, d.z);
      it.push(Math.min(1, c.r * hi), Math.min(1, c.g * hi), Math.min(1, c.b * hi), Math.max(a, opt.sel === i ? 0.5 : 0) * (d.alive ? 1 : 0.8));
      ii.push(ic);
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
      const c = COLOR[sideOf(rec.units[o].side)];
      it.push(c.r, c.g, c.b, a);
      ii.push(dic);
    }
    for (const [k, m] of dModels) {
      if (m.state !== 'ok') continue;
      const L = dPos.get(k) || [];
      const cnt = L.length / 7;
      if (cnt > m.cap) { m.cap = Math.ceil(cnt * 1.5) + 4; if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); } m.mesh = new THREE.InstancedMesh(m.def.geometry, m.def.materials, m.cap); m.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.mesh.frustumCulled = false; scene.add(m.mesh); }
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

    // 开火、导弹、命中、阵亡爆炸（sim-fx.js）
    for (let i = 0; i < n; i++) {
      const d = drawn[i];
      if (!d) { atV[i] = null; continue; }
      atV[i] = (atV[i] || new THREE.Vector3()).set(d.x, d.y, d.z);
    }
    fx.update(t, P, opt.kills);
    drawTac();
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
    const F = frameAt(lastDrawT), bw = 40 * dpr, bh = Math.max(1, 2 * dpr), lh = 13 * dpr + bh * 3 + 3 * dpr;
    const HP_COL = ['#5aa9ff', '#f0b44a', '#e85d5d'];
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
      const x = (vA.x + 1) / 2 * w + 14 * dpr, y = (1 - vA.y) / 2 * h - 4 * dpr, tw = Math.max(bw, lctx.measureText(name).width);
      if (boxes.some((r) => x < r[2] && x + tw > r[0] && Math.abs(y - r[1]) < lh)) continue;
      boxes.push([x, y, x + tw]);
      lctx.fillStyle = sideOf(rec.units[i].side) === 'A' ? '#9cc2ff' : '#ff9d94';
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
      if (!p) return;
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
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
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
      for (const m of models.values()) if (m.mesh) { scene.remove(m.mesh); m.mesh.dispose(); }
      models.clear();
      ORG[0] = ORG[1] = ORG[2] = 0;
      followAt = null;
      cels.set(r?.cel);
      const st = cels.sunType();
      if (st != null) { const c = sunLight(st); sun.color.setRGB(c[0], c[1], c[2]); }
      else { sun.position.set(0.6, 0.5, 0.35); sky.material.uniforms.sun.value.set(0.6, 0.5, 0.35).normalize(); }
    },
    draw,
    render() { watchPerf(); controls.update(); dynFov(); sky.position.copy(camera.position); bg.position.copy(camera.position); if (rec?.cel?.length) celUpdate(); const shook = warpFrame(); if (post && level === 'high') post.render(scene, camera, tunnel?.distScene); else { renderer.setRenderTarget(null); renderer.render(scene, camera); } if (shook) camera.quaternion.copy(shakeQ); drawLabels(); },
    setLabels(on) { labels = on; drawLabels(); },
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
    // 第 i 艘船这一帧画在哪（米）
    drawnPos(i) { const p = drawn[i]; return p ? [p.x / KM + ORG[0], p.y / KM + ORG[1], p.z / KM + ORG[2]] : null; },
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
    dispose() { ro.disconnect(); document.removeEventListener('visibilitychange', onVis); fx.dispose(); for (const m of models.values()) m.mesh?.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove(); lbl.remove(); }
  };
}
