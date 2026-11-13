// ===== 战场模拟：游戏内舰船模型 =====
// 模型由 tools/ship-models/convert.mjs 从 EVE 客户端资源服务器转换到 ship-models/：
//   index.json（typeID → 外观键、总览图标类别）、m/<键>.json（材质参数）、g/<船体>.bin（几何）、t/<键>_{a,n,x}.webp（贴图）
// 材质照搬游戏的 quadv5 着色：材质遮罩按 0、⅓、⅔、1 四档混合 4 种阵营材质（颜色、反光色、光泽），
// 反照率贴图（sRGB）× 材质颜色；x 贴图打包了 粗糙度 / 材质遮罩 / 发光 / 灰尘（灰尘客户端出货着色器不用）。没有转换文件时返回 null，战场只显示图标。
import * as THREE from './vendor/three/three.module.min.js';

const BASE = 'ship-models/';
let indexP = null;
export const loadShipIndex = () => (indexP ||= fetch(BASE + 'index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));

const loader = new THREE.TextureLoader();
const texCache = new Map();
// srgb：quadv5 的 AlbedoMap 带 Tr2sRGB=1 注解（quadv5.sm_hi 参数注解表；EveSpaceSceneEnvMap 也是），引擎按 sRGB 视图采样 = 硬件先转线性；
// 其余贴图（法线 / 粗糙度 / 材质 / 发光）没有这个注解，按线性数据读。DDS 本身是 BC7_UNORM（非 _SRGB），sRGB 只来自注解。
function texture(url, renderer, srgb = false) {
  if (!texCache.has(url)) {
    texCache.set(url, new Promise((ok) => {
      loader.load(url, (t) => {
        t.flipY = false;                    // DirectX 的 UV 原点在左上
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        t.needsUpdate = true;
        ok(t);
      }, undefined, () => ok(null));
    }));
  }
  return texCache.get(url);
}
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
const PLAIN = new THREE.DataTexture(new Uint8Array([160, 0, 0, 0]), 1, 1);   // 缺 x 贴图时：中等光泽、第 1 种材质、不发光
PLAIN.needsUpdate = true;

// 几何：游戏是左手坐标，镜像 X 并翻转三角形绕序，船头仍朝 +Z
const geoCache = new Map();
function geometry(url) {
  if (!geoCache.has(url)) {
    geoCache.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (!buf) return null;
      const dv = new DataView(buf);
      const hl = dv.getUint32(4, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)).replace(/\0+$/, ''));
      const n = head.n;
      let o = 8 + hl;
      const take = (Type, len) => { const a = new Type(buf.slice(o, o + len * Type.BYTES_PER_ELEMENT)); o += Math.ceil(len * Type.BYTES_PER_ELEMENT / 4) * 4; return a; };
      const pos = take(Float32Array, n * 3), nrm = take(Int8Array, n * 4), tan = take(Int8Array, n * 4), uv = take(Float32Array, n * 2);
      const idx = take(head.i32 ? Uint32Array : Uint16Array, head.tris * 3);
      const nf = new Float32Array(n * 3), tf = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = -pos[i * 3];
        nf[i * 3] = -nrm[i * 4] / 127; nf[i * 3 + 1] = nrm[i * 4 + 1] / 127; nf[i * 3 + 2] = nrm[i * 4 + 2] / 127;
        tf[i * 4] = -tan[i * 4] / 127; tf[i * 4 + 1] = tan[i * 4 + 1] / 127; tf[i * 4 + 2] = tan[i * 4 + 2] / 127; tf[i * 4 + 3] = -Math.sign(tan[i * 4 + 3] || 1);
      }
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nf, 3));
      g.setAttribute('tangent', new THREE.BufferAttribute(tf, 4));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      g.userData.areas = head.areas;
      if (head.min && head.max) g.userData.ext = [0, 1, 2].map((k) => Math.max(-head.min[k], head.max[k]));   // 包围盒半轴（米，客户端 GetLocalBoundingBox）
      return g;
    }).catch(() => null));
  }
  return geoCache.get(url);
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
// 光照照 quadv5.sm_hi 的出货变体（反汇编文件第 688–1021 行那段 ps_5_0，非 V5_DEBUG）改写 three 的两段光照函数：
//   环境：镜面 = 反射立方体 × E，漫反射 = 反照率 ×（1 − E）× 模糊立方体；E 是 Lazarov 光泽近似（第 911–915 行，
//         常量 1.041667 / 0.475 / 0.018229 / 0.25、−0.015625 / 0.75、exp2(−9.28·NdotV)），没有 three 的多次散射补偿；
//         镜面再乘地平线遮挡 saturate(1 + 10·(1 − R²)·dot(几何法线, 反射方向))（第 905–907 行）
//   直射：同一个 10·(1 − R²) 因子乘 dot(几何法线, 光方向)（第 974–975 行）；漫反射 × (1 − F)（第 966–973 行，F 用 L·H）
const EVE_LIGHTS = (() => {
  let c = THREE.ShaderChunk.lights_physical_pars_fragment;
  const fnAt = (name) => { const i = c.indexOf(`void ${name}(`); return [i, c.indexOf('\n}', i) + 2]; };
  let [i, j] = fnAt('RE_IndirectSpecular_Physical');
  c = c.slice(0, i) + `void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float g = 1.0 - material.roughness * material.roughness;
	vec4 t = g * vec4( 1.041667, 0.475, 0.018229, 0.25 ) + vec4( 0.0, 0.0, -0.015625, 0.75 );
	float a0 = t.x * min( t.y, exp2( -9.28 * saturate( dot( geometryNormal, geometryViewDir ) ) ) ) + t.z;
	vec3 E = saturate( material.specularColor * ( t.w - a0 ) + a0 );
	float hz = saturate( 1.0 + 10.0 * g * dot( eveGeoN, reflect( - geometryViewDir, geometryNormal ) ) );
	reflectedLight.indirectSpecular += radiance * hz * E;
	reflectedLight.indirectDiffuse += material.diffuseColor * ( 1.0 - E ) * irradiance * RECIPROCAL_PI;
}` + c.slice(j);
  [i, j] = fnAt('RE_Direct_Physical');
  const body = c.slice(i, j)
    .replace('vec3 irradiance = dotNL * directLight.color;',
      'vec3 irradiance = dotNL * directLight.color * saturate( 1.0 + 10.0 * ( 1.0 - material.roughness * material.roughness ) * dot( eveGeoN, directLight.direction ) );')
    .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor ) * ( 1.0 - F_Schlick( material.specularColor, material.specularF90, saturate( dot( directLight.direction, normalize( directLight.direction + geometryViewDir ) ) ) ) );');
  return c.slice(0, i) + body + c.slice(j);
})();

// onBeforeCompile 拿到的是没展开的 #include，要改块里的行得先把块文本取出来再替换
const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
  'vec3 mapN = vec3( ( texture2D( normalMap, vNormalMapUv ).xy + 0.002 ) * 2.0 - 1.0, 1.0 );');

function material(area, maps, env) {
  const m = new THREE.MeshStandardMaterial({ map: maps.a || WHITE, normalMap: maps.n || null, envMap: env, envMapIntensity: 1, metalness: 0, roughness: 1 });
  const u = {
    eveX: { value: maps.x || PLAIN },
    eveD: { value: area.mtl.map((x) => v3(x.d)) },
    eveF: { value: area.mtl.map((x) => v3(x.f)) },
    eveG: { value: new THREE.Vector4(...area.mtl.map((x) => x.g)) },
    eveGlow: { value: v3(area.glow || [0, 0, 0]).multiplyScalar(0.22) },
  };
  // 材质（quadv5 出货变体）：4 档材质权重 = saturate(1.031915 − |MaterialMap − {0,⅓,⅔,1}| × 3.191489)；
  //   漫反射 = 反照率 × Σ权重·MtlNDiffuseColor，F0 = Σ权重·MtlNFresnelColor，光泽 = RoughnessMap × Σ权重·MtlNGloss，粗糙度 = 1 − 光泽。
  //   MtlNDustDiffuseColor / DirtMap / DustNoiseMap 只在 V5_DEBUG 变体（带 switch 的调试视图）里出现，最终颜色不用，这里也不用（x 贴图的 a 通道不读）。
  //   法线：(NormalMap.xy + 0.002) × 2 − 1，直接加到顶点法线上（切线 × x + 副切线 × y + 法线）再归一化，不重建 z（第 757–765 行）
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D eveX; uniform vec3 eveD[4]; uniform vec3 eveF[4]; uniform vec4 eveG; uniform vec3 eveGlow; vec3 eveGeoN;')
      .replace('#include <lights_physical_pars_fragment>', EVE_LIGHTS)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 eP = texture2D(eveX, vMapUv);
        vec4 eW = clamp(1.0319149 - abs(eP.g - vec4(0.0, 0.3333333, 0.6666667, 1.0)) * 3.1914894, 0.0, 1.0);
        vec3 eF0 = eW.x * eveF[0] + eW.y * eveF[1] + eW.z * eveF[2] + eW.w * eveF[3];
        float eGloss = dot(eW, eveG);
        diffuseColor.rgb *= eW.x * eveD[0] + eW.y * eveD[1] + eW.z * eveD[2] + eW.w * eveD[3];`)
      .replace('#include <normal_fragment_maps>', 'eveGeoN = nonPerturbedNormal;\n' + NORMAL_MAPS)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(1.0 - eGloss * eP.r, 0.0, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.specularColor = eF0; material.specularF90 = 1.0;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float eLive = 1.0;
        #if defined( USE_INSTANCING_COLOR )
          eLive = vColor.g;
        #endif
        totalEmissiveRadiance += eveGlow * pow(eP.b, 2.4) * eLive;`);
  };
  m.customProgramCacheKey = () => 'eve-quad5';
  return m;
}

// 一个外观 → { geometry, materials（按几何分组）, r（米）, boosters }
const modelCache = new Map();
export function loadShipModel(key, renderer, env) {
  if (!modelCache.has(key)) {
    modelCache.set(key, (async () => {
      const def = await fetch(`${BASE}m/${key}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!def) return null;
      const src = await geometry(BASE + def.geo);
      if (!src) return null;
      const g = src.clone();
      g.clearGroups();
      const tri = src.userData.areas;
      const mats = [];
      for (const a of def.areas) {
        const first = tri[a.index]?.[0];
        if (first == null) continue;
        let count = 0;
        for (let k = a.index; k < a.index + a.count && tri[k]; k++) count += tri[k][1];
        const t = (c) => (a.tex.has.includes(c) || c === 'x' ? texture(`${BASE}t/${a.tex.k}_${c}.webp`, renderer, c === 'a') : null);
        const [ta, tn, tx] = await Promise.all([t('a'), t('n'), t('x')]);
        g.addGroup(first * 3, count * 3, mats.length);
        mats.push(material(a, { a: ta, n: tn, x: tx }, env));
      }
      if (!mats.length) return null;
      return { geometry: g, materials: mats, r: def.r, c: def.c || [0, 0, 0], ext: g.userData.ext || null, boosters: def.boosters || [], boosterColor: def.boosterColor, bst: def.bst || null, loc: def.loc || {}, se: def.se || null };
    })());
  }
  return modelCache.get(key);
}

// 总览图标：assets/brackets/<类别>.png 拼成一行图集
export const BRACKETS = ['frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'carrier', 'dreadnought', 'titan', 'supercarrier', 'forceauxiliary', 'freighter', 'industrial', 'industrialcommand', 'miningbarge', 'miningfrigate', 'shuttle', 'rookie', 'capsule',
  'dronelightscout', 'dronemediumscout', 'droneheavyattack', 'dronesentry', 'fightersquad', 'fightersquadm', 'fightersquadh', 'wreck'];
// 无人机 / 舰载机图标：引擎记录的类别 0–6（轻 / 中 / 重 / 岗哨无人机，轻型 / 支援 / 重型舰载机）
export const DRONE_BRACKETS = BRACKETS.slice(18, 25).map((b) => BRACKETS.indexOf(b));
let atlasP = null;
export function bracketAtlas() {
  return (atlasP ||= Promise.all(BRACKETS.map((b) => new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = `assets/brackets/${b}.png?v=1`; }))).then((ims) => {
    const c = document.createElement('canvas');
    c.width = 32 * BRACKETS.length; c.height = 32;
    const x = c.getContext('2d');
    // 16 像素的小图标（无人机、舰载机、残骸）放大到 24 像素，和舰船图标里的图形差不多大
    ims.forEach((im, i) => { if (!im) return; const w = im.width < 32 ? 24 : im.width, h = im.height < 32 ? 24 : im.height; x.drawImage(im, i * 32 + (32 - w) / 2, (32 - h) / 2, w, h); });
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }));
}
