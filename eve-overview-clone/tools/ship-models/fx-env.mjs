// 深渊环境特效（边界泡 / 深渊云团 / 天气云层）→ 驾驶模拟用的静态文件（assets/eveui/fx/env/），js/sim-env.js 播放
// 用法：node fx-env.mjs [--local /opt/eve/eve-space-vfx] [--out ../../assets/eveui/fx/env]
//   本地解包目录里有的直接读，没有的按最新客户端的资源索引从 resources.eveonline.com 下载（下载的文件只交给解析器读）
//   和 fx-effects.mjs 的输出目录分开，不会覆盖 assets/eveui/fx/cfx/ 里已有的文件
// 输出：
//   <名>.json        特效对象树（解析器读出的原样结构，去掉声音、观察者；网格 / 贴图路径换成本地文件名）
//                    另附 tex3d：用到的体积贴图 { 名: [宽, 高, 深, 通道数] }
//   mesh/<名>.json   { p, n, uv, i, a }（位置保留 7 位有效数字：边界球网格半径只有 0.01，再按 7,500,000 放大，4 位小数不够；
//                    a = 各区域在 i 里的 [起点, 个数]，Tr2MeshArea.index / count 按它选三角形）
//   tex/<名>.png     2D 贴图（RGBA，边长最多 512，GPU 粒子图集保留 1024）
//   tex/<名>.bin     体积贴图（原始字节，x 最快、再 y、再 z；见 ../ui-assets/env-tex.py）
// 模型与贴图版权归 CCP，仅供本站驾驶模拟画面使用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const LOCALS = [args.local || '/opt/eve/eve-space-vfx', '/opt/eve/eve-module-fx'];
const OUT = resolve(args.out || join(HERE, '../../assets/eveui/fx/env'));
for (const d of [OUT, join(OUT, 'mesh'), join(OUT, 'tex')]) mkdirSync(d, { recursive: true });

// 输出名 → 客户端文件。云团的 SDE 类型 → 文件见 js/sim-env.js 的 CLOUD_FILE
const EFFECTS = {
  // SDE 类型 47465「Unstable Abyssal Depths」
  boundary: 'res:/fisfx/environment/boundary/boundary_bubble.black',
  // SDE 组 1971 的云团（graphicFile 的 .black 版）
  bio10: 'res:/fisfx/environment/aoe/aoe_bioluminescence_10k_rt_01a.black',
  bio30: 'res:/fisfx/environment/aoe/aoe_bioluminescence_30k_rt_01a.black',
  bio80: 'res:/fisfx/environment/aoe/aoe_bioluminescence_80k_rt_01a.black',
  caustic10: 'res:/fisfx/environment/aoe/aoe_causticwave_10k_rt_01a.black',
  caustic30: 'res:/fisfx/environment/aoe/aoe_causticwave_30k_rt_01a.black',
  caustic80: 'res:/fisfx/environment/aoe/aoe_causticwave_80k_rt_01a.black',
  filament10: 'res:/fisfx/environment/aoe/aoe_filament_10k_rt_01a.black',
  filament30: 'res:/fisfx/environment/aoe/aoe_filament_30k_rt_01a.black',
  filament80: 'res:/fisfx/environment/aoe/aoe_filament_80k_rt_01a.black',
  // 深渊天气云层
  cc_electricstorm: 'res:/fisfx/environment/cloudcover/cc_abyssal_electricstorm_s3_01a.black',
  cc_darkness: 'res:/fisfx/environment/cloudcover/cc_abyssal_darkness_s3_01a.black',
  cc_caustictoxin: 'res:/fisfx/environment/cloudcover/cc_abyssal_caustictoxin_s3_01a.black',
  cc_xenongas: 'res:/fisfx/environment/cloudcover/cc_abyssal_xenongas_s3_01a.black',
  cc_infernal: 'res:/fisfx/environment/cloudcover/cc_abyssal_infernal_s3_01a.black',
  // 场景共用的 GPU 粒子系统（Tr2GpuUniqueEmitter 发出的粒子由它模拟和绘制：图集、噪声）
  gpu: 'res:/fisfx/gpuparticles/system.black',
};
// GPU 粒子更新着色器的湍流噪声（system.black 里 update 效果的 NoiseMap）
const EXTRA_TEX = ['res:/texture/global/noise32cube_volume.dds'];
// 边长上限放宽到 1024 的贴图（GPU 粒子图集：8 格横排，每格 128）
const BIG = new Set(['systematlas']);
const DROP = new Set(['observers', 'audio', 'stretchAudio', 'sourceTriObserver', 'controllers', 'fxAttributes']);

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  let b = Buffer.from(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
  return b;
}
let index = null;
async function cdn(p) {
  if (!index) {
    index = new Map();
    const BIN = 'https://binaries.eveonline.com/';
    const build = JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
    const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
    for (const [, path] of app.split('\n').map((l) => l.split(',')).filter((x) => x[0] === 'app:/resfileindex.txt')) {
      for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) { const x = l.split(','); if (x[1]) index.set(x[0].toLowerCase(), x[1]); }
    }
  }
  const ref = index.get(p.toLowerCase());
  if (!ref) throw new Error('索引里没有 ' + p);
  return fetchBuf('https://resources.eveonline.com/' + ref);
}
const localOf = (res) => LOCALS.map((d) => join(d, res.slice(5).toLowerCase())).find((f) => existsSync(f));
const getRes = async (res) => { const f = localOf(res); return f ? readFileSync(f) : cdn(res); };

await import('@carbonenginejs/runtime');
const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');
const gr2 = await import('@carbonenginejs/runtime/resource/formats/gr2');
const cmf = await import('@carbonenginejs/runtime/resource/formats/cmf');
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const p7 = (x) => +(+x).toPrecision(7);
const meshes = new Map(), textures = new Map();
const keyOf = (res) => basename(res).replace(/\.[a-z0-9]+$/i, '').toLowerCase();

// 解析器的对象 → 纯 JSON（保留 _type / _id / _ref），路径换成本地名
function clean(o) {
  if (ArrayBuffer.isView(o)) return Array.from(o, (x) => +(+x).toFixed(5));
  if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
  if (!o || typeof o !== 'object') return typeof o === 'number' ? +o.toPrecision(9) : o;
  if (/^Aud/.test(o._type || '')) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (DROP.has(k)) continue;
    if (k === 'geometryResPath' && v) { const key = keyOf(v); meshes.set(key, v); out.geo = key; continue; }
    if (k === 'resourcePath' && v) { const key = keyOf(v); textures.set(key, v); out.tex = key; continue; }
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const roots = {};
for (const [kind, res] of Object.entries(EFFECTS)) {
  const r = await CjsBlackFormat.read(new Uint8Array(await getRes(res)));
  const j = JSON.parse(JSON.stringify(r.object, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  roots[kind] = { file: res, root: clean(j) };
  console.log(kind, res);
}
for (const res of EXTRA_TEX) textures.set(keyOf(res), res);
for (const [key, res] of meshes) {
  const g = gr2.CjsGr2Format.read(new Uint8Array(await getRes(res)));
  const m = cmf.CjsCmfFormat.loadShared(g).meshes[0];
  const lod = m.lods[0], v = lod.vertex || m.vertex;
  const n = v.position.length / 3;
  writeFileSync(join(OUT, 'mesh', key + '.json'), JSON.stringify({
    p: Array.from(v.position, p7),
    n: v.normal?.length ? Array.from(v.normal.slice(0, n * 3), r4) : [],
    uv: v.texcoord0?.length ? Array.from(v.texcoord0.slice(0, n * 2), r4) : [],
    i: Array.from(m.indexBuffer ?? lod.indexBuffer),
    a: (lod.areas || []).map((x) => [x.firstElement * 3, x.elementCount * 3]),
  }));
  console.log('mesh', key, n, (lod.areas || []).length);
}
// 贴图：DDS 先放 .cache/env/，再由 ../ui-assets/env-tex.py 转 PNG / 体积贴图 .bin
const TEX = join(HERE, '.cache/env');
mkdirSync(TEX, { recursive: true });
for (const [key, res] of textures) writeFileSync(join(TEX, key + '.dds'), await getRes(res));
const big = [...textures.keys()].filter((k) => BIG.has(k));
const small = [...textures.keys()].filter((k) => !BIG.has(k));
for (const [list, max] of [[small, 512], [big, 1024]]) {
  if (!list.length) continue;
  const r = spawnSync('python3', ['-I', join(HERE, '../ui-assets/env-tex.py'), TEX, join(OUT, 'tex'), String(max), ...list], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(r.stdout);
  if (r.status) process.exit(r.status);
}
// 体积贴图的尺寸（env-tex.py 写在 tex/<名>.bin.json）记进用到它的特效 JSON
const vols = Object.fromEntries([...textures.keys()].filter((k) => existsSync(join(OUT, 'tex', k + '.bin.json'))).map((k) => [k, JSON.parse(readFileSync(join(OUT, 'tex', k + '.bin.json'), 'utf8'))]));
for (const [kind, data] of Object.entries(roots)) {
  const s = JSON.stringify(data.root);
  const used = Object.fromEntries(Object.entries(vols).filter(([k]) => s.includes(`"tex":"${k}"`)));
  // GPU 粒子更新用的湍流噪声不在对象树里，单独挂到 gpu.json
  if (kind === 'gpu') Object.assign(used, Object.fromEntries(EXTRA_TEX.map(keyOf).filter((k) => vols[k]).map((k) => [k, vols[k]])));
  if (Object.keys(used).length) data.tex3d = used;
  writeFileSync(join(OUT, kind + '.json'), JSON.stringify(data));
}
console.log('done', OUT);
