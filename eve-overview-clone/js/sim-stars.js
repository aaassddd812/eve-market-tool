// 近处闪烁星精灵：照客户端 EveStarfield（trinity/Eve/EveStarfield.cpp）。
// 客户端 sceneManager._PrepareBackgroundLandscapes 给每个星系挂 res:/dx9/scene/starfield/spritestars.red：
//   种子 = 星座 ID，minDist 40、maxDist 80（米），颗数 = 500 + int(250 × 安全等级)，非已知空间（虫洞、深渊）0 颗。
//   spritestars.black：minFlashRate 0.1、maxFlashRate 0.4、minFlashIntensity 0.5；
//   StarSprites.fx：MaxIntensity 0.5、MinIntensity 0.25，DiffuseMap = staratlas（512² 单通道，2×2 图集），PaletteMap = starcolors（32×1，没有 α）。
// 生成（EveStarfield::OnPrepareResources / GenerateStar）：TriSrand(种子)，每颗星依次取 8 个 TriRand ——
//   t = 2π·r，u = (r − 0.5)·2，d = r，半径 = lerp(min, max, d²)，位置 = 半径 ×(√(1−u²)·cos t, √(1−u²)·sin t, u)；
//   颜色号 = r，闪烁强度 = r ×(1 − minFlashIntensity) + minFlashIntensity，相位 = r，速率 = lerp(minFlashRate, maxFlashRate, r)，图集格 = TriRandInt(4)
//   TriRand（trinity/TriMath.cpp）：jran = (jran·4096 + 150889) mod 714025，返回 jran / 714025；TriSrand(s)：jran = s mod 714025
// 绘制（实机 RenderDoc 抓帧 frame32757：VS 3728f762 / PS 4a178abd，加色 One/One、只写 RGB、不写深度，在背景之后、舰船之前）：
//   视空间位置 = 视矩阵的旋转 × 位置（不平移：星点跟着镜头走、没有视差），再在视空间按角点 ±0.5 展开成方块；
//   uv = (格号 & 1, 格号 >> 1) × 0.5 + 角点 uv（0 / 0.5）；强度 = MinIntensity + MaxIntensity ×(1 − |sin(速率·时间 + 相位)|)²；
//   输出 = saturate(调色板(颜色号, 0) ×(图集.r, 图集.r, 图集.r, 1) × 强度) × 闪烁强度
// 坐标：场景坐标 = 客户端坐标；长度按千米（客户端的 40–80 米 = 0.04–0.08）。
import * as THREE from './vendor/three/three.module.min.js';

const KM = 1 / 1000;
const SF = { minDist: 40, maxDist: 80, minFlashRate: 0.1, maxFlashRate: 0.4, minFlashIntensity: 0.5, maxIntensity: 0.5, minIntensity: 0.25 };

// 颗数：客户端用 sm.GetService('map').GetSecurityStatus（eveFormat.FmtSystemSecStatus，反编译源码里没有这个函数），
//   这里按客户端显示的一位小数取（pilot-systems.json 的 sec 已是两位小数）
export const starCount = (sec, known = true) => (known ? 500 + Math.trunc(250 * Math.round((sec || 0) * 10) / 10) : 0);

function generate(seed, n) {
  let j = (seed >>> 0) % 714025;
  const rnd = () => { j = (j * 4096 + 150889) % 714025; return Math.fround(j / 714025); };
  const rndInt = (hi) => { j = (j * 4096 + 150889) % 714025; return Math.trunc(hi * j / 714025); };
  const pos = new Float32Array(n * 12), a = new Float32Array(n * 16), b = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const t = rnd() * 2 * Math.PI, u = (rnd() - 0.5) * 2, d = rnd();
    const r = SF.minDist + (SF.maxDist - SF.minDist) * d * d, sq = Math.sqrt(1 - u * u);
    const x = r * sq * Math.cos(t), y = r * sq * Math.sin(t), z = r * u;
    const col = rnd(), flash = rnd() * (1 - SF.minFlashIntensity) + SF.minFlashIntensity, phase = rnd();
    const rate = rnd() * (SF.maxFlashRate - SF.minFlashRate) + SF.minFlashRate, tex = rndInt(4);
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos.set([x * KM, y * KM, z * KM], v * 3);
      a.set([col, flash, phase, rate], v * 4);
      b.set([k, tex], v * 2);
    }
  }
  return { pos, a, b };
}

// fxDir：assets/eveui/fx/（tools/ui-assets/fetch.mjs --starfield 转出 starfield/staratlas.png、starcolors.png）
export function createStarfield(fxDir) {
  const load = (f) => {
    const t = new THREE.TextureLoader().load(`${fxDir}starfield/${f}?v=1`);
    t.colorSpace = THREE.NoColorSpace;   // 客户端两张都是 UNORM，按原值用
    t.flipY = false;   // uv 原点在左上（D3D）
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };
  const atlas = load('staratlas.png'), pal = load('starcolors.png');
  pal.generateMipmaps = false; pal.minFilter = THREE.LinearFilter;
  const mat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, pal: { value: pal }, time: { value: 0 }, inten: { value: new THREE.Vector2(SF.maxIntensity, SF.minIntensity) } },
    vertexShader: `attribute vec4 sa; attribute vec2 sb; uniform float time; uniform vec2 inten;
      varying vec2 vUv; varying vec3 vS;
      void main() {
        int k = int(sb.x + 0.5), g = int(sb.y + 0.5);
        vec2 c = vec2(k == 1 || k == 2 ? 0.5 : -0.5, k >= 2 ? 0.5 : -0.5);
        vec4 v = vec4(mat3(viewMatrix) * position, 1.0);
        v.xy += c * ${(KM).toFixed(6)};
        gl_Position = projectionMatrix * v;
        vUv = vec2(float(g - (g / 2) * 2), float(g / 2)) * 0.5 + vec2(k == 1 || k == 2 ? 0.5 : 0.0, k >= 2 ? 0.5 : 0.0);
        float s = 1.0 - abs(sin(sa.w * time + sa.z));
        vS = vec3(sa.x, s * s * inten.x + inten.y, sa.y);
      }`,
    fragmentShader: `uniform sampler2D atlas, pal; varying vec2 vUv; varying vec3 vS;
      void main() {
        vec3 p = texture2D(pal, vec2(vS.x, 0.5)).rgb;
        gl_FragColor = vec4(clamp(p * texture2D(atlas, vUv).r * vS.y, 0.0, 1.0) * vS.z, 1.0);
      }`,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,   // 客户端写掩码只有 RGB
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10.5;   // 背景球（-11）之后、舰船之前
  mesh.visible = false;
  return {
    mesh,
    // seed：星座 ID；n：颗数（starCount），0 = 不画
    set(seed, n) {
      n = Math.max(0, n | 0);
      mesh.visible = n > 0;
      if (!n) return;
      const { pos, a, b } = generate(seed, n);
      const idx = new Uint32Array(n * 6);
      for (let i = 0; i < n; i++) idx.set([0, 1, 2, 0, 2, 3].map((x) => x + i * 4), i * 6);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('sa', new THREE.BufferAttribute(a, 4));
      geo.setAttribute('sb', new THREE.BufferAttribute(b, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    },
    update(t) { mat.uniforms.time.value = t; },
    dispose() { geo.dispose(); mat.dispose(); atlas.dispose(); pal.dispose(); },
  };
}
