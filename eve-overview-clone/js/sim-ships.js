// ===== 战场模拟：游戏内舰船模型 =====
// 模型由 tools/ship-models/convert.mjs 从 EVE 客户端资源服务器转换到 ship-models/：
//   index.json（typeID → 外观键、总览图标类别）、m/<键>.json（材质参数）、g/<船体>.bin（几何）、t/<键>_{a,n,x}.webp（贴图）
// 材质照搬游戏的 quadv5 着色：材质遮罩按 0、⅓、⅔、1 四档混合 4 种阵营材质（颜色、反光色、光泽），
// 反照率贴图（sRGB）× 材质颜色；x 贴图打包了 粗糙度 / 材质遮罩 / 发光 / 灰尘（灰尘客户端出货着色器不用）。没有转换文件时返回 null，战场只显示图标。
import * as THREE from './vendor/three/three.module.min.js';
import { SHIP_AO } from './sim-ssao.js?v=1';
import { SHIP_LIGHTS, PL_MAX, IES_TEX } from './sim-lights.js?v=7';

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

// 几何：照原样用（船头朝 +Z）。客户端世界是右手系、和 three 同一套约定（实机抓帧 frame32757：船体世界矩阵行列式 +1，
//   投影 w = −z_view，船壳光栅态 CullMode.Front + FrontCounterClockwise = false 即剔除屏幕上顺时针的面；
//   af5_t2 的三角形 7540 / 7554 按逆时针朝外），所以几何、挂点、灯、特效都不镜像。
//   天体坐标就是 SDE 坐标（抓帧里的太阳方向和 1DH-SX 血袭者空间站的 SDE 坐标对得上，误差 0.16°）
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
        nf[i * 3] = nrm[i * 4] / 127; nf[i * 3 + 1] = nrm[i * 4 + 1] / 127; nf[i * 3 + 2] = nrm[i * 4 + 2] / 127;
        tf[i * 4] = tan[i * 4] / 127; tf[i * 4 + 1] = tan[i * 4 + 1] / 127; tf[i * 4 + 2] = tan[i * 4 + 2] / 127; tf[i * 4 + 3] = Math.sign(tan[i * 4 + 3] || 1);
      }
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
//   两层（实机船壳 PS 2f06fc / 推进器区 4ad4c7 反汇编，RenderDoc 抓帧）：主层和灰尘层各算一遍完整光照（直射 + 环境），
//   最终 = 主层 × (1 − x)³ + 灰尘层 × x。下面把 three 的两个光照函数改名成单层版本，外面包一层按 eveWA / eveWB 加权；
//   灰尘层的环境镜面按它自己的粗糙度另取一次（客户端也是按灰尘层粗糙度另算立方体 mip）
//   二次光照 SH（每物体 ShLighting[7]，sim-shl.js 算）：漫反射环境 = 立方体 + max(SH(N), 0) / π（第 133–146 行，带常数项）；
//     镜面 = 立方体 × 地平线遮挡 + max(SH'(R), 0) × α / (5 − 4α)（第 105–120 行，SH' 不带常数项，α = 粗糙度²），再一起 × E；N、R 是世界方向
const EVE_LIGHTS = (() => {
  let c = THREE.ShaderChunk.lights_physical_pars_fragment;
  const fnAt = (name) => { const i = c.indexOf(`void ${name}(`); return [i, c.indexOf('\n}', i) + 2]; };
  { const k = c.indexOf('};', c.indexOf('struct PhysicalMaterial')) + 2; c = c.slice(0, k) + '\nPhysicalMaterial eveMB; float eveWA = 1.0, eveWB = 0.0; vec3 eveShD = vec3( 0.0 ), eveShS = vec3( 0.0 );' + c.slice(k); }
  let [i, j] = fnAt('RE_IndirectSpecular_Physical');
  c = c.slice(0, i) + `void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float g = 1.0 - material.roughness * material.roughness;
	vec4 t = g * vec4( 1.041667, 0.475, 0.018229, 0.25 ) + vec4( 0.0, 0.0, -0.015625, 0.75 );
	float a0 = t.x * min( t.y, exp2( -9.28 * saturate( dot( geometryNormal, geometryViewDir ) ) ) ) + t.z;
	vec3 E = saturate( material.specularColor * ( t.w - a0 ) + a0 );
	float hz = saturate( 1.0 + 10.0 * g * dot( eveGeoN, reflect( - geometryViewDir, geometryNormal ) ) );
	float a = material.roughness * material.roughness;
	reflectedLight.indirectSpecular += ( radiance * hz + eveShS * a / ( 5.0 - 4.0 * a ) ) * E;
	reflectedLight.indirectDiffuse += material.diffuseColor * ( 1.0 - E ) * ( irradiance + eveShD ) * RECIPROCAL_PI;
}` + c.slice(j);
  [i, j] = fnAt('RE_Direct_Physical');
  const body = c.slice(i, j)
    .replace('vec3 irradiance = dotNL * directLight.color;',
      'vec3 irradiance = dotNL * directLight.color * saturate( 1.0 + 10.0 * ( 1.0 - material.roughness * material.roughness ) * dot( eveGeoN, directLight.direction ) );')
    .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor ) * ( 1.0 - F_Schlick( material.specularColor, material.specularF90, saturate( dot( directLight.direction, normalize( directLight.direction + geometryViewDir ) ) ) ) );');
  c = c.slice(0, i) + body + c.slice(j);
  const ARGS = 'const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal';
  c = c.replace('void RE_Direct_Physical(', 'void eveDirect1(').replace('void RE_IndirectSpecular_Physical(', 'void eveIndirect1(');
  const k = c.indexOf('#define RE_Direct');
  return c.slice(0, k) + `void RE_Direct_Physical( const in IncidentLight directLight, ${ARGS}, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	ReflectedLight a = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) ), b = a;
	eveDirect1( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, a );
	if ( eveWB > 0.0 ) eveDirect1( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, eveMB, b );
	reflectedLight.directDiffuse += a.directDiffuse * eveWA + b.directDiffuse * eveWB;
	reflectedLight.directSpecular += a.directSpecular * eveWA + b.directSpecular * eveWB;
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, ${ARGS}, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	ReflectedLight a = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) ), b = a;
	eveIndirect1( radiance, irradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, a );
	if ( eveWB > 0.0 ) {
		vec3 radB = radiance;
		#ifdef USE_ENVMAP
			radB = getIBLRadiance( geometryViewDir, geometryNormal, eveMB.roughness );
		#endif
		eveIndirect1( radB, irradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, eveMB, b );
	}
	reflectedLight.indirectDiffuse += a.indirectDiffuse * eveWA + b.indirectDiffuse * eveWB;
	reflectedLight.indirectSpecular += a.indirectSpecular * eveWA + b.indirectSpecular * eveWB;
}
` + c.slice(k);
})();

// onBeforeCompile 拿到的是没展开的 #include，要改块里的行得先把块文本取出来再替换
const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
  'vec3 mapN = vec3( ( texture2D( normalMap, vNormalMapUv ).xy + 0.002 ) * 2.0 - 1.0, 1.0 );');

// 船体共用贴图（assets/eveui/fx/ship/，客户端 res:/dx9/model/shared/dirtdetailnoise.dds（DustNoiseMap）、res:/texture/global/noise.dds（HeatGlowNoiseMap））
const FX = 'assets/eveui/fx/ship/';
let shared = null;
const sharedTex = (renderer) => (shared ||= { dust: texture(FX + 'dirtdetailnoise.png?v=1', renderer), heat: texture(FX + 'noise.png?v=1', renderer) });
// 着色器时间（秒，客户端 PerSceneData 的时间 cb2[21].x）：sim-3d 每帧写
export const SHIP_TIME = { value: 0 };
// 推进器区热光（quadheatv5）每种材质的 HeatGlowData：x = 跟推进器亮度开关（1）/ 常亮（0），y = 噪声滚动速度，z = 噪声 UV 缩放，w = 扭曲量。
//   旧转换文件里没有，按 SOF 里最常见的 area_booster 默认值
const HEAT_DEF = [1, 0.025, 4, 0.002];

function material(area, maps, env, sh, shl) {
  const heat = area.kind === 'heat';
  const m = new THREE.MeshStandardMaterial({ map: maps.a || WHITE, normalMap: maps.n || null, envMap: env, envMapIntensity: 1, metalness: 0, roughness: 1 });
  const u = {
    eveX: { value: maps.x || PLAIN },
    eveD: { value: area.mtl.map((x) => v3(x.d)) },
    eveF: { value: area.mtl.map((x) => v3(x.f)) },
    eveU: { value: area.mtl.map((x) => v3(x.u || [0, 0, 0])) },
    eveG: { value: new THREE.Vector4(...area.mtl.map((x) => x.g)) },
    eveGlow: { value: v3((heat ? area.heat : area.glow) || [0, 0, 0]) },
    eveHD: { value: area.mtl.map((x) => new THREE.Vector4(...(x.h || HEAT_DEF))) },
    eveDust: { value: sh.dust || WHITE }, eveHN: { value: sh.heat || WHITE },
    eveDirt: { value: 0 },      // shipData.z = dirtLevel：引擎默认 0，只有玩家船按 dirtTime 算（这里没有这个数据）
    eveTime: SHIP_TIME,
    eveAO: SHIP_AO.tex, eveAOOn: SHIP_AO.on,
    eveLN: SHIP_LIGHTS.n, eveLP: SHIP_LIGHTS.p, eveLC: SHIP_LIGHTS.c, eveLD: SHIP_LIGHTS.d, eveLE: SHIP_LIGHTS.e, eveIES: { value: IES_TEX },
    eveSH: shl.sh, eveShK: shl.k,
  };
  // 材质（实机船壳 PS）：4 档材质权重 = saturate(1.031915 − |MaterialMap − {0,⅓,⅔,1}| × 3.191489)；
  //   主层：漫反射 = 反照率 × Σ权重·MtlNDiffuseColor，F0 = Σ权重·MtlNFresnelColor，光泽 = RoughnessMap × Σ权重·MtlNGloss，粗糙度 = 1 − 光泽。
  //     （PaintMaskMap（_p3）× GeneralData.x 会把主层往 不着色 / F0 0.039 / 光泽 0.4 拉；出厂外观的 _p3 抽查 16 艘几乎全黑（SKIN 才用），没转换，不做）
  //   灰尘层：噪声 n = DustNoiseMap(UV × 20) + 0.5；漫反射 = 反照率 × Σ权重·MtlNDustDiffuseColor × n.x，F0 = (0.019, 0.017, 0.014) × n.y，
  //     粗糙度 = saturate(1 − RoughnessMap × n.z × 0.4)；混合量 x = saturate(DirtMap × n.w / (1 − dirtLevel))，最终 = 主层 ×(1 − x)³ + 灰尘层 × x
  //   法线：(NormalMap.xy + 0.002) × 2 − 1，直接加到顶点法线上（切线 × x + 副切线 × y + 法线）再归一化，不重建 z
  //   发光：船壳 = GeneralGlowColor × GlowMap^2.4 × shipData.y（ActivationStrength，平时 1）；
  //     推进器区（quadheatv5）= GeneralHeatGlowColor × 开关 × GlowMap(UV 加噪声扭曲)^2.4 × shipData.y，
  //     开关 = saturate(1 + HD.x ×(saturate((推进器亮度 − 0.005) × 66.67) − 1))，扭曲 = (噪声(UV + HD.y·t)·HD.z × 噪声(UV − HD.y·t)·HD.z − 0.5) × HD.w × 开关
  //   实例颜色：r = 变暗（死船 0.22），g = shipData.y，b = 推进器亮度（EveShip2::GetPerObjectData，封顶 1；只看是否 > 0.02）
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    // 二次光照的接收者强度：实例化（舰船、残骸、无人机、炮塔）按实例属性 eveShI，单个网格（空间站）按统一量 eveShK；
    //   在顶点着色器里选好传给片元（three 的片元着色器不定义 USE_INSTANCING）
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float eveShK; varying float vShI;
        #ifdef USE_INSTANCING
          attribute float eveShI;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vShI = eveShI;
        #else
          vShI = eveShK;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D eveX, eveDust, eveHN; uniform vec3 eveD[4]; uniform vec3 eveF[4]; uniform vec3 eveU[4]; uniform vec4 eveG; uniform vec3 eveGlow; uniform vec4 eveHD[4];
        uniform float eveDirt, eveTime; vec3 eveGeoN; uniform sampler2D eveAO; uniform float eveAOOn;
        uniform int eveLN; uniform vec4 eveLP[${PL_MAX}]; uniform vec4 eveLC[${PL_MAX}]; uniform vec4 eveLD[${PL_MAX}]; uniform vec4 eveLE[${PL_MAX}]; uniform sampler2D eveIES;
        uniform vec4 eveSH[7]; varying float vShI;
        vec3 eveShEval(vec3 d, float c) {
          vec4 n = vec4(d, c), q = d.yzzx * d.xyzz;
          vec3 r = vec3(dot(eveSH[0], n), dot(eveSH[1], n), dot(eveSH[2], n)) + vec3(dot(eveSH[3], q), dot(eveSH[4], q), dot(eveSH[5], q)) + eveSH[6].xyz * (d.x * d.x - d.y * d.y);
          return max(r, 0.0);
        }`)
      .replace('#include <lights_physical_pars_fragment>', EVE_LIGHTS)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 eAlb = diffuseColor.rgb;
        vec4 eP = texture2D(eveX, vMapUv);
        vec4 eN = texture2D(eveDust, vMapUv * 20.0) + 0.5;
        vec4 eW = clamp(1.0319149 - abs(eP.g - vec4(0.0, 0.3333333, 0.6666667, 1.0)) * 3.1914894, 0.0, 1.0);
        vec3 eF0 = eW.x * eveF[0] + eW.y * eveF[1] + eW.z * eveF[2] + eW.w * eveF[3];
        vec3 eDust = eW.x * eveU[0] + eW.y * eveU[1] + eW.z * eveU[2] + eW.w * eveU[3];
        vec4 eHD = eW.x * eveHD[0] + eW.y * eveHD[1] + eW.z * eveHD[2] + eW.w * eveHD[3];
        float eGloss = dot(eW, eveG);
        diffuseColor.rgb *= eW.x * eveD[0] + eW.y * eveD[1] + eW.z * eveD[2] + eW.w * eveD[3];`)
      // three r160 的片元着色器有实例颜色时只定义 USE_COLOR（USE_INSTANCING_COLOR 只在顶点着色器里）；
      //   船体材质不开 vertexColors，所以这里的 vColor 只会是实例颜色，不能当 RGB 直接乘（b = 推进器亮度，停船时是 0）
      .replace('#include <color_fragment>', `float eLive = 1.0, eBoost = 1.0;
        #if defined( USE_COLOR )
          diffuseColor.rgb *= vColor.r; eAlb *= vColor.r; eLive = vColor.g; eBoost = vColor.b;
        #endif`)
      .replace('#include <normal_fragment_maps>', 'eveGeoN = nonPerturbedNormal;\n' + NORMAL_MAPS)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(1.0 - eGloss * eP.r, 0.0, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.specularColor = eF0; material.specularF90 = 1.0;
        eveMB = material;
        eveMB.diffuseColor = eAlb * eDust * eN.x;
        eveMB.specularColor = vec3(0.019, 0.017, 0.014) * eN.y;
        eveMB.roughness = min(max(clamp(1.0 - eP.r * eN.z * 0.4, 0.0, 1.0), 0.0525) + geometryRoughness, 1.0);
        eveWB = clamp(eP.a * eN.w / (1.0 - eveDirt), 0.0, 1.0);
        eveWA = (1.0 - eveWB) * (1.0 - eveWB) * (1.0 - eveWB);`)
      // 船体灯（sim-lights.js；实机船壳 PS 2f06fc 的灯循环）：距离 d、半径 R 都按米，
      //   衰减 = saturate((1/(d+0.001) − 1/(R+0.001)) / (1000 − 1/(R+0.001))) × 1000（约 1/d，到 R 归零），
      //   聚光灯 × saturate((cos − cos外)/(cos内 − cos外))²（有 IES 灯型再 × 曲线(0.5 − 0.5·cos)），颜色 ×(1 − 模糊)，模糊 = clamp(内半径 / d, 0, 0.8)，
      //   粗糙度 α = min(α + 模糊⁴, 1)（两层各自加），然后和太阳同一套直射光照（RE_Direct）
      .replace('#include <lights_fragment_maps>', `for (int i = 0; i < ${PL_MAX}; i++) {
          if (i >= eveLN) break;
          vec3 lv = eveLP[i].xyz - geometryPosition;
          float ld = length(lv) * 1000.0, lR = eveLP[i].w;
          if (ld >= lR) continue;
          vec3 lL = normalize(lv);
          float lF = clamp(eveLC[i].w / ld, 0.0, 0.8);
          float lA = clamp((1.0 / (ld + 0.001) - 1.0 / (lR + 0.001)) / (999.999939 - 1.0 / (lR + 0.001)), 0.0, 1.0) * 999.999939;
          if (eveLD[i].w > 0.0) {
            float lc = dot(eveLD[i].xyz, lL), lt = clamp((lc - eveLD[i].w) / (eveLE[i].x - eveLD[i].w), 0.0, 1.0); lA *= lt * lt;
            if (eveLE[i].y > 0.5) lA *= textureLod(eveIES, vec2(0.5 - 0.5 * lc, (eveLE[i].y - 0.5) / 32.0), 0.0).r;   // IES 灯型（sim-lights.js IES_TEX 第 y − 1 行）
          }
          if (lA <= 0.0) continue;
          directLight.color = eveLC[i].rgb * lA * (1.0 - lF); directLight.direction = lL; directLight.visible = true;
          float lF4 = lF * lF * lF * lF, rA = material.roughness, rB = eveMB.roughness;
          material.roughness = sqrt(min(rA * rA + lF4, 1.0)); eveMB.roughness = sqrt(min(rB * rB + lF4, 1.0));
          RE_Direct(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          material.roughness = rA; eveMB.roughness = rB;
        }
        #include <lights_fragment_maps>
        {
          float eK = vShI;
          if (eK > 0.0) {
            eveShD = eveShEval(normalize((vec4(geometryNormal, 0.0) * viewMatrix).xyz), 1.0) * eK;
            eveShS = eveShEval(normalize((vec4(reflect(-geometryViewDir, geometryNormal), 0.0) * viewMatrix).xyz), 0.0) * eK;
          }
        }`)
      // SSAO（sim-ssao.js）：客户端最终颜色 = 光照 × AO，再雾、再加发光
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        if (eveAOOn > 0.5) {
          float eAO = texelFetch(eveAO, ivec2(gl_FragCoord.xy), 0).r;
          reflectedLight.directDiffuse *= eAO; reflectedLight.directSpecular *= eAO;
          reflectedLight.indirectDiffuse *= eAO; reflectedLight.indirectSpecular *= eAO;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef EVE_HEAT
          float eOn = clamp(1.0 + eHD.x * (clamp((eBoost - 0.005) * 66.66667, 0.0, 1.0) - 1.0), 0.0, 1.0);
          vec2 eH1 = texture2D(eveHN, (vMapUv + eHD.y * eveTime) * eHD.z).xy, eH2 = texture2D(eveHN, (vMapUv - eHD.y * eveTime) * eHD.z).xy;
          float eGl = texture2D(eveX, vMapUv + eHD.w * eOn * (eH1 * eH2 - 0.5)).b;
          totalEmissiveRadiance += eveGlow * eOn * pow(eGl, 2.4) * eLive;
        #else
          totalEmissiveRadiance += eveGlow * pow(eP.b, 2.4) * eLive;
        #endif`);
  };
  if (heat) m.defines.EVE_HEAT = '';   // 保留 three 自带的 STANDARD
  m.customProgramCacheKey = () => (heat ? 'eve-quad5h' : 'eve-quad5');
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
      // 二次光照（sim-shl.js）：每个外观一份 7 行系数，sim-3d / sim-station 每帧写；k = 非实例化网格的接收者强度
      const shl = { sh: { value: Array.from({ length: 7 }, () => new THREE.Vector4()) }, k: { value: 0 } };
      for (const a of def.areas) {
        const first = tri[a.index]?.[0];
        if (first == null) continue;
        let count = 0;
        for (let k = a.index; k < a.index + a.count && tri[k]; k++) count += tri[k][1];
        const t = (c) => (a.tex.has.includes(c) || c === 'x' ? texture(`${BASE}t/${a.tex.k}_${c}.webp`, renderer, c === 'a') : null);
        const [ta, tn, tx, dust, heat] = await Promise.all([t('a'), t('n'), t('x'), sharedTex(renderer).dust, sharedTex(renderer).heat]);
        g.addGroup(first * 3, count * 3, mats.length);
        mats.push(material(a, { a: ta, n: tn, x: tx }, env, { dust, heat }, shl));
      }
      if (!mats.length) return null;
      return { geometry: g, materials: mats, r: def.r, c: def.c || [0, 0, 0], ext: g.userData.ext || null, boosters: def.boosters || [], boosterColor: def.boosterColor, bst: def.bst || null, loc: def.loc || {}, se: def.se || null, lights: def.lights || null, bl: def.bl || null, ies: def.ies || null, anim: def.anim || null, shl };
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
