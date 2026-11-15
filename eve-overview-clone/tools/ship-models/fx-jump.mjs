// 深渊口袋之间过导管的过场特效（effects.JumpOutAbyssalBetween）→ 驾驶模拟用的静态文件（assets/eveui/fx/jump/），js/sim-jump.js 播放
// 用法：node fx-jump.mjs [--local /opt/eve/eve-space-vfx] [--out ../../assets/eveui/fx/jump]
//   本地解包目录里有的直接读，没有的按最新客户端的资源索引从 resources.eveonline.com 下载（下载的文件只交给解析器读，不执行）
//   结构照 fx-env.mjs；和其它特效的输出目录分开
// 资源（/opt/eve/fsd-json/effects.json：effects.JumpOutAbyssalBetween）：
//   graphicID 21014          = res:/fisfx/module/jumpout_tr_t1a     自己船身上的跃迁离开特效（ShipEffect，挂在船上）
//   secondaryGraphicID 22073 = res:/fisfx/travel/abyssal/abyssal_tunnelbetween_01a  隧道（scene.warpTunnel 槽）
// 输出：
//   tunnel.json / jumpout.json   特效对象树（解析器读出的原样结构，去掉声音、观察者；网格 / 贴图路径换成本地文件名）
//   mesh/<名>.json               { p, n, uv, i, a }（同 fx-env.mjs）
//   tex/<名>.png                 2D 贴图（RGBA，边长最多 512）
//   tex/<名>/{px,nx,py,ny,pz,nz}.webp  立方体贴图（隧道的 NebulaMap = dx9/scene/universe/m10_cube.dds，BC6H HDR；
//                                      ../ui-assets/bc6h.mjs 解码 → sky.py nebula 按 sRGB 编码存，加载时按 sRGB 解回线性）
// 模型与贴图版权归 CCP，仅供本站驾驶模拟画面使用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const LOCALS = [args.local || '/opt/eve/eve-space-vfx', '/opt/eve/eve-module-fx'];
const OUT = resolve(args.out || join(HERE, '../../assets/eveui/fx/jump'));
for (const d of [OUT, join(OUT, 'mesh'), join(OUT, 'tex')]) mkdirSync(d, { recursive: true });

const EFFECTS = {
  tunnel: 'res:/fisfx/travel/abyssal/abyssal_tunnelbetween_01a.black',
  jumpout: 'res:/fisfx/module/jumpout_tr_t1a.black',
};
const CUBE_SIZE = 512;   // 立方体贴图每面边长（原图 2048）
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
  console.log('下载', p);
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
const meshes = new Map(), textures = new Map(), cubes = new Map();
const keyOf = (res) => basename(res).replace(/\.[a-z0-9]+$/i, '').toLowerCase();

function clean(o) {
  if (ArrayBuffer.isView(o)) return Array.from(o, (x) => +(+x).toFixed(5));
  if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
  if (!o || typeof o !== 'object') return typeof o === 'number' ? +o.toPrecision(9) : o;
  if (/^Aud/.test(o._type || '')) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (DROP.has(k)) continue;
    if (k === 'geometryResPath' && v) { const key = keyOf(v); meshes.set(key, v); out.geo = key; continue; }
    if (k === 'resourcePath' && v) {
      const key = keyOf(v);
      // 立方体贴图（星云）另外转：dx9/scene/universe/*_cube.dds
      if (/_cube\.dds$/i.test(v)) { cubes.set(key, v); out.cube = key; } else { textures.set(key, v); out.tex = key; }
      continue;
    }
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
// 2D 贴图：DDS 先放 .cache/jump/，再由 ../ui-assets/env-tex.py 转 PNG
const TEX = join(HERE, '.cache/jump');
mkdirSync(TEX, { recursive: true });
for (const [key, res] of textures) writeFileSync(join(TEX, key + '.dds'), await getRes(res));
if (textures.size) {
  const r = spawnSync('python3', ['-I', join(HERE, '../ui-assets/env-tex.py'), TEX, join(OUT, 'tex'), '512', ...textures.keys()], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(r.stdout);
  if (r.status) process.exit(r.status);
}
// 立方体贴图：BC6H → 浮点（bc6h.mjs）→ 6 张 WebP（sky.py nebula，sRGB 编码）
for (const [key, res] of cubes) {
  const dds = join(TEX, key + '.dds'), f32 = join(TEX, key + '.f32');
  writeFileSync(dds, await getRes(res));
  let r = spawnSync('node', [join(HERE, '../ui-assets/bc6h.mjs'), dds, f32], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  r = spawnSync('python3', ['-I', join(HERE, '../ui-assets/sky.py'), 'nebula', f32, join(OUT, 'tex', key), String(CUBE_SIZE)], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  console.log('cube', key);
}
for (const [kind, data] of Object.entries(roots)) writeFileSync(join(OUT, kind + '.json'), JSON.stringify(data));
console.log('done', OUT);
