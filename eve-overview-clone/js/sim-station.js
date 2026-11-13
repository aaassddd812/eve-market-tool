// ===== 驾驶模拟的空间站、星门模型 =====
// 客户端 station.py / stargate.py：和舰船一样按 graphicID 拼 SOF DNA 装配模型，所以这里直接用舰船那套
//   （tools/ship-models/convert.mjs --celestials 转出的 ship-models/，index.cel：typeID → 外观键；sim-ships.js 的加载和 quad 材质），
//   受同一个恒星方向光照。客户端加载后播 NormalLoop 动画、挂交通 / 宣传 / 灯光等子模型（SOF hull.children），这里只画静态船体 + 发光贴图。
// 只在近处画：客户端镜头远裁剪面 10,000 km（ui/camera/baseCamera.py），再远本来就看不到模型、只剩总览图标（sim-3d 照常画）。
// 朝向：客户端 SetStaticRotation 用服务器给的 dunRotation（偏航 / 俯仰 / 滚转，度），本地数据里没有；
//   这里按天体名字 + typeID 做种子取一个固定的偏航角，俯仰、滚转取 0（推断）。
//   客户端还有一份「永远朝向恒星」的类型表（TYPES_THAT_ALWAYS_FACE_THE_SUN），本地拿不到内容，没有照做。
import * as THREE from './vendor/three/three.module.min.js';
import { loadShipIndex } from './sim-ships.js?v=v11';

const KM = 1 / 1000;
const SHOW = 10000;   // 千米：客户端远裁剪面
const LOAD = 12000;   // 千米：进入这个距离开始下载模型

// scene：three 场景；opt.load(外观键) → Promise<模型>（sim-3d 的 loadModel，带环境反射）；opt.env() → [环境贴图, 强度]
export function createStations(scene, opt = {}) {
  const group = new THREE.Group();
  scene.add(group);
  let list = [], gen = 0, index = null;
  loadShipIndex().then((x) => { index = x; });
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  function set(cel) {
    for (const o of list) if (o.mesh) group.remove(o.mesh);
    list = [];
    gen++;
    for (const c of cel || []) {
      if (c.group !== 10 && c.group !== 15) continue;
      list.push({ c, state: 'wait', mesh: null, yaw: (hash(`${c.name}|${c.type}`) / 4294967296) * Math.PI * 2 });
    }
  }
  function load(o) {
    const key = index?.cel?.[o.c.type];
    if (!key || !opt.load) { o.state = 'none'; return; }
    o.state = 'loading';
    const g = gen;
    opt.load(key).then((def) => {
      if (g !== gen) return;
      if (!def) { o.state = 'none'; return; }
      o.mesh = new THREE.Mesh(def.geometry, def.materials);
      o.mesh.scale.setScalar(KM);
      o.mesh.rotation.set(0, o.yaw, 0);
      o.mesh.frustumCulled = false;
      o.mesh.visible = false;
      o.mats = def.materials;
      group.add(o.mesh);
      o.state = 'ok';
    }).catch(() => { o.state = 'none'; });
  }
  // camera：镜头；ORG：浮动原点（米）
  function update(camera, ORG) {
    if (!list.length) return;
    const cx = camera.position.x / KM + ORG[0], cy = camera.position.y / KM + ORG[1], cz = camera.position.z / KM + ORG[2];
    const [env, envI] = opt.env ? opt.env() : [null, 1];
    for (const o of list) {
      const p = o.c.pos;
      const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) * KM;
      if (o.state === 'wait' && index && d < LOAD) load(o);
      if (!o.mesh) continue;
      o.mesh.visible = d < SHOW;
      if (!o.mesh.visible) continue;
      o.mesh.position.set((p[0] - ORG[0]) * KM, (p[1] - ORG[1]) * KM, (p[2] - ORG[2]) * KM);
      // 星空（环境反射）比模型晚到时补上
      if (env && o.mats[0]?.envMap !== env) for (const mt of o.mats) { mt.envMap = env; mt.envMapIntensity = envI; mt.needsUpdate = true; }
    }
  }
  return { set, update };
}
