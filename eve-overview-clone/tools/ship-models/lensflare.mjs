// 恒星镜头光晕（fisfx/lensflare/*.black + .gr2）→ 驾驶模拟用的静态文件（assets/eveui/fx/lensflare/），js/sim-flare.js 播放
// 用法：node lensflare.mjs [--local /opt/eve/eve-space-vfx] [--out ../../assets/eveui/fx/lensflare]
//   .black / .gr2 读本地解包目录；贴图、遮挡精灵网格按最新客户端的资源索引从 resources.eveonline.com 下载（下载的文件只交给解析器读）
// 哪个星系用哪个光晕：客户端 sun.py 取 cfg.mapSystemCache[星系].sunFlareGraphicID（res:/staticdata/systems.static），
//   驾驶模拟的四个星系查出来是 1243 orange_sun（艾玛、帕多尔）、1244 pink_sun_small（新加达里）、1245 orange_radiating（泛光之源）
// 输出 <名>.json：
//   mesh { p: [x, y …], uv: [u, v …], i: [三角形索引], areas: [[起始索引, 索引数] …] }（gr2 网格区域）
//   layers [{ name, area, tex, mod, p: { 常量参数 }, ids: { 参数名: _id } }]（只收 lensflare.fx 的区域）
//   curves { edge|center|angle|x|y: [{ id, keys: [[时间, 值, 插值] …] }] }、bindings [{ src, dst, comp }]
//   occluders / bgOccluders [{ name, scale: [x, y], z }]、sprite（zsprite.gr2 的 xy 范围）、occTex
// 贴图 tex/<名>.png。版权归 CCP，仅供本站驾驶模拟画面使用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const LOCAL = args.local || '/opt/eve/eve-space-vfx';
const OUT = resolve(args.out || join(HERE, '../../assets/eveui/fx/lensflare'));
for (const d of [OUT, join(OUT, 'tex')]) mkdirSync(d, { recursive: true });
const FLARES = ['orange_sun', 'pink_sun_small', 'orange_radiating'];

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
const getRes = async (res) => { const f = join(LOCAL, res.slice(5).toLowerCase()); return existsSync(f) ? readFileSync(f) : cdn(res); };

await import('@carbonenginejs/runtime');
const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');
const gr2 = await import('@carbonenginejs/runtime/resource/formats/gr2');
const cmf = await import('@carbonenginejs/runtime/resource/formats/cmf');
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const keyOf = (res) => basename(res).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
const textures = new Map();
const tex = (res) => { const k = keyOf(res); textures.set(k, res); return k; };
const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
const loadMesh = (buf) => cmf.CjsCmfFormat.loadShared(gr2.CjsGr2Format.read(new Uint8Array(buf))).meshes[0];

for (const name of FLARES) {
  const j = plain((await CjsBlackFormat.read(new Uint8Array(readFileSync(join(LOCAL, 'fisfx/lensflare', name + '.black')))) ).object);
  const m = loadMesh(readFileSync(join(LOCAL, 'fisfx/lensflare', name + '.gr2')));
  const lod = m.lods[0], v = lod.vertex || m.vertex, n = v.position.length / 3;
  const mesh = { p: [], uv: [], i: Array.from(m.indexBuffer ?? lod.indexBuffer), areas: lod.areas.map((a) => [a.firstElement * 3, a.elementCount * 3]) };
  for (let k = 0; k < n; k++) mesh.p.push(r5(v.position[k * 3]), r5(v.position[k * 3 + 1])), mesh.uv.push(r5(v.texcoord0[k * 2]), r5(v.texcoord0[k * 2 + 1]));
  const layers = [];
  for (const a of j.mesh.additiveAreas || []) {
    const e = a.effect;
    if (!/\/lensflare\.fx$/i.test(e.effectFilePath)) { console.log('skip', name, a.name, e.effectFilePath); continue; }
    const p = {}, ids = {};
    for (const c of e.constParameters || []) p[c.name] = c.value;
    for (const c of e.parameters || []) { p[c.name] = Array.isArray(c.value) ? c.value : [c.value]; if (c._id !== undefined) ids[c.name] = c._id; }
    const res = Object.fromEntries((e.resources || []).map((r) => [r.name, r.resourcePath && tex(r.resourcePath)]));
    if ((a.count ?? 1) !== 1) throw new Error('area count ' + a.count);
    layers.push({ name: a.name, area: a.index ?? 0, tex: res.TexMap, mod: res.ModulationTexMap, p, ids });
  }
  const curves = {};
  for (const [k, f] of [['edge', 'distanceToEdgeCurves'], ['center', 'distanceToCenterCurves'], ['angle', 'radialAngleCurves'], ['x', 'xDistanceToCenter'], ['y', 'yDistanceToCenter']]) {
    curves[k] = (j[f] || []).map((c) => {
      if (c._type !== 'Tr2CurveScalar' || c.extrapolationBefore || c.extrapolationAfter || (c.timeScale ?? 1) !== 1 || c.timeOffset) throw new Error('curve ' + JSON.stringify(c).slice(0, 200));
      return { id: c._id, name: c.name, keys: c.keys.map((x) => [x.time, x.value, x.interpolation ?? 2, x.leftTangent || 0, x.rightTangent || 0]) };
    });
  }
  const bindings = (j.bindings || []).map((b) => {
    if (b.sourceAttribute !== 'currentValue') throw new Error('binding ' + b.name);
    const [, comp] = /^value(?:\.([xyzw]))?$/.exec(b.destinationAttribute) || [];
    return { name: b.name, src: b.sourceObject?._ref, dst: b.destinationObject?._ref, comp: comp || 'x' };
  });
  const occ = (list) => (list || []).map((o) => {
    const s = o.sprites[0];
    const r = s.mesh.opaqueAreas[0].effect.resources.find((x) => x.name === 'TexMap');
    tex(r.resourcePath);
    return { name: o.name, modifier: s.modifier, scale: [s.scaling[0], s.scaling[1]], z: s.translation[2], geo: s.mesh.geometryResPath, tex: keyOf(r.resourcePath) };
  });
  const out = { file: `res:/fisfx/lensflare/${name}.black`, name: j.name, cameraFactor: j.cameraFactor ?? 20, mesh, layers, curves, bindings, occluders: occ(j.occluders), bgOccluders: occ(j.backgroundOccluders) };
  // 遮挡精灵网格（zsprite.gr2）的 xy 范围
  const geo = out.occluders[0]?.geo;
  if (geo) {
    const sm = loadMesh(await getRes(geo)), sv = (sm.lods[0].vertex || sm.vertex).position;
    let mx = 0;
    for (let k = 0; k < sv.length; k += 3) mx = Math.max(mx, Math.abs(sv[k]), Math.abs(sv[k + 1]));
    out.sprite = r5(mx);
    out.occTex = out.occluders[0].tex;
  }
  writeFileSync(join(OUT, name + '.json'), JSON.stringify(out));
  console.log(name, 'layers', layers.length, 'verts', n, 'sprite', out.sprite);
}
// 贴图：DDS 放 .cache/lensflare/，再由 ../ui-assets/cfx-tex.py 转 PNG
const TEX = join(HERE, '.cache/lensflare');
mkdirSync(TEX, { recursive: true });
for (const [key, res] of textures) writeFileSync(join(TEX, key + '.dds'), await getRes(res));
const r = spawnSync('python3', ['-I', join(HERE, '../ui-assets/cfx-tex.py'), TEX, join(OUT, 'tex'), ...textures.keys()], { stdio: 'inherit' });
if (r.status) process.exit(r.status);
