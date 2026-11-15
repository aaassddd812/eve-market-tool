// 动态反射立方体：照客户端 Tr2ReflectionProbe + EveSpaceSceneRenderDriver::RenderReflectionFaces 的做法自己实现。
//   客户端：探头放在相机位置，每帧只重画一个面（m_renderFrequency 默认 ONE_SIDE_PER_FRAME，第一圈 6 面一起画），
//     面缓冲 512²（R11G11B10），场景照常画（背景、天体、船和建筑；材质的反射强度压到 min(0.8, 1/强度²)，免得反射里的反射越叠越亮）；
//     预滤波（ReflectionFilterActivisionPre，实机抓帧 CS 19bf6f / mip0 拷贝 7b9750）：降采样、sRGB → 线性，再加
//       「好莱坞」背光：c += c × BackLightColor(2) × (对比度 8 + 2) × saturate(−dot(相机朝向, 方向))⁸ / 2π，
//       即朝相机身后（反射回镜头那一侧）的方向最多亮约 3.2 倍；
//     然后 Activision 的 GGX 预积分（CS 5a4c86）出 256²、8 级 mip，船壳按 (1 − gloss) × 7 取 mip。
// 这里：预滤波照抄算法（4 点按立体角加权降到 256²），GGX 那一步用 three 的 PMREM（同样是 GGX 重要性采样，mip 和粗糙度的对应关系是 three 的）。
//   反射面里不画界面（总览图标、旗子、射程圈、战术圆盘）、不加 SSAO 和船体点光（客户端每个面有自己的灯表，这里省掉）。
import * as THREE from './vendor/three/three.module.min.js';

const FACE = 512, OUT = 256;
const BACK = { color: 2, contrast: 8 };

const VS = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const FS = `precision highp float;
  uniform samplerCube src; uniform int face; uniform vec3 view; uniform float size;
  out vec4 color;
  // GL 立方体贴图第 face 面上 (u, v) ∈ [−1, 1] 的取样方向（three 渲染目标立方体：取样方向 = 世界方向）
  vec3 dirOf(vec2 p) {
    float u = p.x, v = p.y;
    if (face == 0) return vec3(1.0, -v, -u);
    if (face == 1) return vec3(-1.0, -v, u);
    if (face == 2) return vec3(u, 1.0, v);
    if (face == 3) return vec3(u, -1.0, -v);
    if (face == 4) return vec3(u, -v, 1.0);
    return vec3(-u, -v, -1.0);
  }
  vec3 lin(vec3 c) { return mix(pow(abs((c + 0.055) * 0.9478673), vec3(2.4)), c * 0.07739938, vec3(lessThan(c, vec3(0.04045)))); }
  void main() {
    // 一个输出像素覆盖源的 2×2：在 1/8、7/8 处取 4 点，权重 = 0.125 + 0.5 × r³ / Σr³（r² = u² + v² + 1）
    vec2 base = gl_FragCoord.xy - 0.5;
    vec2 a = (base + 0.125) / size * 2.0 - 1.0, b = (base + 0.875) / size * 2.0 - 1.0;
    vec2 P[4] = vec2[4](a, vec2(b.x, a.y), vec2(a.x, b.y), b);
    float r3[4]; float s = 0.0;
    for (int i = 0; i < 4; i++) { float r = dot(P[i], P[i]) + 1.0; r3[i] = r * sqrt(r); s += r3[i]; }
    vec3 c = vec3(0.0);
    for (int i = 0; i < 4; i++) c += lin(textureLod(src, dirOf(P[i]), 0.0).rgb) * (0.125 + 0.5 * r3[i] / s);
    vec3 d = normalize(dirOf((gl_FragCoord.xy / size) * 2.0 - 1.0));
    float k = pow(clamp(-dot(normalize(view), d), 0.0, 1.0), ${BACK.contrast.toFixed(1)});
    c += c * k * ${BACK.color.toFixed(1)} * ${(BACK.contrast + 2).toFixed(1)} * 0.159236;
    color = vec4(c, 1.0);
  }`;

export function createReflection(renderer) {
  const faceRT = new THREE.WebGLCubeRenderTarget(FACE, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  // 和主场景缓冲一样：材质往里写 sRGB 编码值（背景等自定义着色器也按这个约定输出），预滤波再解回线性
  faceRT.isXRRenderTarget = true; faceRT.texture.colorSpace = THREE.SRGBColorSpace;
  const outRT = new THREE.WebGLCubeRenderTarget(OUT, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const cubeCam = new THREE.CubeCamera(0.0002, 30000, faceRT);
  const pm = new THREE.PMREMGenerator(renderer);
  let pmRT = null;
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false,
    uniforms: { src: { value: faceRT.texture }, face: { value: 0 }, view: { value: new THREE.Vector3() }, size: { value: OUT } } });
  const qs = new THREE.Scene(), qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false; qs.add(quad);
  let face = 0, primed = false;
  return {
    get texture() { return pmRT?.texture || null; },
    // hide：反射里不画的物体；before / after：画面前后调整材质（反射强度、SSAO、点光）
    update(scene, camera, hide, before, after) {
      if (cubeCam.coordinateSystem !== renderer.coordinateSystem) { cubeCam.coordinateSystem = renderer.coordinateSystem; cubeCam.updateCoordinateSystem(); }
      cubeCam.position.copy(camera.position);
      cubeCam.children.forEach((c) => { c.near = camera.near; c.far = camera.far; c.updateProjectionMatrix(); });
      cubeCam.updateMatrixWorld(true);
      const vis = hide.map((o) => o?.visible);
      hide.forEach((o) => { if (o) o.visible = false; });
      const au = renderer.shadowMap.autoUpdate, rt0 = renderer.getRenderTarget();
      renderer.shadowMap.autoUpdate = false;
      before?.();
      const faces = primed ? [face] : [0, 1, 2, 3, 4, 5];
      for (const f of faces) { renderer.setRenderTarget(faceRT, f); renderer.clear(); renderer.render(scene, cubeCam.children[f]); }
      after?.();
      renderer.shadowMap.autoUpdate = au;
      hide.forEach((o, i) => { if (o) o.visible = vis[i]; });
      face = (face + 1) % 6; primed = true;
      // 预滤波 → 256² 立方体
      camera.getWorldDirection(mat.uniforms.view.value);
      for (let f = 0; f < 6; f++) { mat.uniforms.face.value = f; renderer.setRenderTarget(outRT, f); renderer.render(qs, qc); }
      renderer.setRenderTarget(rt0);
      // GGX 预积分（three PMREM，复用同一个目标）
      pmRT = pm.fromCubemap(outRT.texture, pmRT);
      return pmRT.texture;
    },
    dispose() { faceRT.dispose(); outRT.dispose(); pmRT?.dispose(); pm.dispose(); mat.dispose(); },
  };
}
