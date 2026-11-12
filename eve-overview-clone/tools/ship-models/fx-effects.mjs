// 装备特效（fisfx/module/*.black）→ 驾驶模拟用的静态文件（assets/eveui/fx/cfx/），js/sim-cfx.js 播放
// 用法：node fx-effects.mjs [--local /opt/eve/eve-space-vfx] [--out ../../assets/eveui/fx/cfx]
//   本地解包目录里有的直接读，没有的按最新客户端的资源索引从 resources.eveonline.com 下载（下载的文件只交给解析器读）
// 输出：
//   <特效>.json  特效对象树（解析器读出的原样结构，去掉声音、观察者；网格 / 贴图路径换成本地文件名）
//   mesh/<名>.json  { p, n, uv, i }（位置 / 法线 / UV / 三角形索引，坐标保留 4 位小数）
//   tex/<名>.png    贴图（保留 RGBA，边长最多 256）；立方体贴图是 tex/<名>/{px,nx,py,ny,pz,nz}.png
// 模型与贴图版权归 CCP，仅供本站驾驶模拟画面使用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const LOCALS = [args.local || '/opt/eve/eve-space-vfx', '/opt/eve/eve-module-fx'];
const OUT = resolve(args.out || join(HERE, '../../assets/eveui/fx/cfx'));
for (const d of [OUT, join(OUT, 'mesh'), join(OUT, 'tex')]) mkdirSync(d, { recursive: true });

// 驾驶模拟里的电子战类别 → 客户端特效文件（SDE graphicID 的 graphicFile）
const EFFECTS = {
  web: 'res:/fisfx/module/stasisweb_tr_t1a.black',
  scram: 'res:/fisfx/module/warpscrambler_st_t1a.black',
  point: 'res:/fisfx/module/warpdisruptor_st_t1a.black',
  neut: 'res:/fisfx/module/energydestabilization_st_t1a.black',
  nos: 'res:/fisfx/module/energyvampire_st_t1a.black',
  ecm: 'res:/fisfx/module/ecm_tr_t1a.black',
  damp: 'res:/fisfx/module/sensordampener_st_t1a.black',
};
// 不需要的字段（声音、观察者、灯光以外的运行时对象）
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
const meshes = new Map(), textures = new Map();
const keyOf = (res) => basename(res).replace(/\.[a-z0-9]+$/i, '').toLowerCase();

// 解析器的对象 → 纯 JSON（保留 _type / _id / _ref），路径换成本地名
function clean(o) {
  if (ArrayBuffer.isView(o)) return Array.from(o, (x) => +(+x).toFixed(5));
  if (Array.isArray(o)) return o.map(clean).filter((x) => x !== undefined);
  if (!o || typeof o !== 'object') return typeof o === 'number' ? +o.toFixed(6) : o;
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

for (const [kind, res] of Object.entries(EFFECTS)) {
  const r = await CjsBlackFormat.read(new Uint8Array(await getRes(res)));
  const j = JSON.parse(JSON.stringify(r.object, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
  writeFileSync(join(OUT, kind + '.json'), JSON.stringify({ file: res, root: clean(j) }));
  console.log(kind, res);
}
for (const [key, res] of meshes) {
  const g = gr2.CjsGr2Format.read(new Uint8Array(await getRes(res)));
  const m = cmf.CjsCmfFormat.loadShared(g).meshes[0];
  const lod = m.lods[0], v = lod.vertex || m.vertex;
  const n = v.position.length / 3;
  writeFileSync(join(OUT, 'mesh', key + '.json'), JSON.stringify({
    p: Array.from(v.position, r4),
    n: v.normal?.length ? Array.from(v.normal.slice(0, n * 3), r4) : [],
    uv: v.texcoord0?.length ? Array.from(v.texcoord0.slice(0, n * 2), r4) : [],
    i: Array.from(m.indexBuffer ?? lod.indexBuffer),
  }));
  console.log('mesh', key, n);
}
// 贴图：DDS 先放 .cache/cfx/，再由 ../ui-assets/cfx-tex.py 转 PNG
const TEX = join(HERE, '.cache/cfx');
mkdirSync(TEX, { recursive: true });
for (const [key, res] of textures) writeFileSync(join(TEX, key + '.dds'), await getRes(res));
const r = spawnSync('python3', ['-I', join(HERE, '../ui-assets/cfx-tex.py'), TEX, join(OUT, 'tex'), ...textures.keys()], { stdio: 'inherit' });
if (r.status) process.exit(r.status);
// 立方体贴图（转成目录的）记进每个特效 JSON 的 cubes，播放端直接按立方体贴图加载，不用先试 PNG
const cubes = [...textures.keys()].filter((k) => existsSync(join(OUT, 'tex', k, 'px.png')));
for (const kind of Object.keys(EFFECTS)) {
  const f = join(OUT, kind + '.json'), j = JSON.parse(readFileSync(f, 'utf8'));
  const used = cubes.filter((k) => JSON.stringify(j.root).includes(`"tex":"${k}"`));
  if (used.length) j.cubes = used; else delete j.cubes;
  writeFileSync(f, JSON.stringify(j));
}
