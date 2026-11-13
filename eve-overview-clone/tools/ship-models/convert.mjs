// 舰船模型转换：EVE 客户端资源服务器 → 战场模拟用的静态文件（ship-models/）
//
// 用法：node --max-old-space-size=6000 convert.mjs --sde <SDE 目录> [--out <输出目录>] [--only 587,24690] [--cats 6,18,87] [--build 3628513] [--max 2048] [--keep-cache] [--wrecks] [--turrets]
//   --wrecks：另外转通用残骸 wreck_s / wreck_m / wreck_l（SDE 残骸组 186：护卫舰级 s、驱逐 ~ 巡洋 m、战巡 ~ 战列 l），index.wrecks 记 { s, m, l: 模型键 }
//   --turrets：另外转炮塔 / 发射器模型（装备 graphicFile 在 model/turret/ 下的 EveTurretSet），index.turrets 记 { 装备 typeID: 模型键 }
//   --celestials [pilot-systems.json]：不转舰船，改转星门（组 10）/ 空间站（组 15）。这些类型 SDE 里 published=false，所以不看 published；
//     客户端 station.py / stargate.py 和舰船一样按 graphicID 拼 SOF DNA。给了 pilot-systems.json 就只转里面出现的类型（可再加 --only）；
//     index.cel 记 { typeID: 模型键 }（不进 index.types，免得被当成舰船）。模型半径 2–60 km，贴图建议 --max 1024
//     例：node --max-old-space-size=6000 convert.mjs --celestials ../../pilot-systems.json --max 1024 --cache <新建的空目录>
//   --cache <目录>：下载缓存放这里（默认 tools/ship-models/.cache）
//
// 流程（只用公开资源，不需要客户端）：
//   1. binaries.eveonline.com 取当前客户端版本 → resfileindex（res:/ 路径 → 下载地址）
//   2. 下载并解析 SOF 数据（dx9/model/spaceobjectfactory/data.black）
//   3. SDE 里每个已发布舰船 → graphicID → hull:faction:race（SOF DNA）
//   4. SOF 按 DNA 算出网格区域、材质参数（Mtl1~4 颜色/反光/光泽/灰尘、发光色）和贴图路径
//   5. .gr2 → 自定义二进制几何（g/<hull>.bin）；DDS → WebP（textures.py）
//   6. index.json：typeID → 模型键、总览图标类别、半径
//
// 模型与贴图版权归 CCP，仅供本站战场画面使用。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const SDE = args.sde || resolve(HERE, '../../../../sde');
const OUT = resolve(args.out || join(HERE, '../../ship-models'));
const CACHE = resolve(args.cache || join(HERE, '.cache'));
const MAX = Number(args.max) || 2048;
const ONLY = args.only ? new Set(String(args.only).split(',').map(Number)) : null;
const BIN = 'https://binaries.eveonline.com/';
const RES = 'https://resources.eveonline.com/';
for (const d of [OUT, join(OUT, 'g'), join(OUT, 't'), join(OUT, 'm'), CACHE]) mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const jsonl = (f) => readFileSync(join(SDE, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const md5 = (s) => createHash('md5').update(s).digest('hex').slice(0, 16);

async function fetchBuf(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      let b = Buffer.from(await r.arrayBuffer());
      if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
      return b;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
    }
  }
}

// ── 资源索引 ──
const INDEX = new Map();
async function loadIndex() {
  // --build：固定客户端版本（新版 SOF 数据有解析库还不认识的字段时用旧版）
  const build = args.build || JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
  const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
  const want = app.split('\n').map((l) => l.split(',')).filter((p) => p[0] === 'app:/resfileindex.txt');
  for (const [, path] of want) {
    for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) {
      const p = l.split(',');
      if (p[1]) INDEX.set(p[0].toLowerCase(), p[1]);
    }
  }
  // 固定旧版本时：每个船体单独的 .black（含受损火焰 / 受击定位点）新版本才有这些定位点，这一类条目一律用最新版的
  if (args.build) {
    try {
      const latest = JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
      const app2 = (await fetchBuf(`${BIN}eveonline_${latest}.txt`)).toString();
      let n = 0;
      for (const [, path] of app2.split('\n').map((l) => l.split(',')).filter((p) => p[0] === 'app:/resfileindex.txt')) {
        for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) {
          const p = l.split(',');
          const k = (p[0] || '').toLowerCase();
          if (p[1] && k.startsWith('res:/dx9/model/spaceobjectfactory/hulls/')) { INDEX.set(k, p[1]); n++; }
        }
      }
      log('从最新版本', latest, '补船体文件条目', n);
    } catch (e) { log('最新版索引读取失败（不影响模型，只是没有定位点）', e.message); }
  }
  log('客户端版本', build, '资源条目', INDEX.size);
  return build;
}
const hasRes = (p) => INDEX.has(String(p).toLowerCase());
const cacheFile = (p) => join(CACHE, INDEX.get(p.toLowerCase()).replace('/', '_'));
async function getRes(p) {
  if (!hasRes(p)) throw new Error('资源不存在 ' + p);
  const f = cacheFile(p);
  if (existsSync(f)) return readFileSync(f);
  const b = await fetchBuf(RES + INDEX.get(p.toLowerCase()));
  writeFileSync(f, b);
  return b;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ── 总览图标类别（按 SDE 舰船组名，对应 res:/ui/texture/shared/brackets/<名>_32.png）──
const BRACKET_RULES = [
  [/capsule/, 'capsule'], [/shuttle/, 'shuttle'], [/corvette|rookie/, 'rookie'],
  [/force auxiliary/, 'forceauxiliary'], [/supercarrier/, 'supercarrier'], [/carrier/, 'carrier'],
  [/dreadnought/, 'dreadnought'], [/titan/, 'titan'], [/freighter/, 'freighter'],
  [/industrial command|capital industrial/, 'industrialcommand'], [/mining barge|exhumer/, 'miningbarge'],
  [/expedition frigate/, 'miningfrigate'], [/battlecruiser|command ship/, 'battlecruiser'],
  [/battleship|black ops|marauder/, 'battleship'], [/destroyer|interdictor/, 'destroyer'],
  [/frigate|interceptor|covert ops|stealth bomber|electronic attack/, 'frigate'],
  [/cruiser|recon|logistics/, 'cruiser'], [/hauler|industrial|transport|blockade runner/, 'industrial'],
];
const bracketOf = (groupName, hullCat) => {
  const g = String(groupName || '').toLowerCase();
  for (const [re, b] of BRACKET_RULES) if (re.test(g)) return b;
  const c = String(hullCat || '').toLowerCase();
  for (const [re, b] of BRACKET_RULES) if (re.test(c)) return b;
  return 'frigate';
};

// ── 几何：.gr2 → g/<hull>.bin ──
// 格式：'ESM1' | u32 头长度 | 头 JSON | 4 字节对齐的缓冲区（pos f32×3, nrm i8×4, tan i8×4(w=手性), uv f32×2, idx u16/u32）
let gr2, cmf, tangent;
async function writeGeometry(resPath, file) {
  const g = gr2.CjsGr2Format.read(new Uint8Array(await getRes(resPath)));
  const shared = cmf.CjsCmfFormat.loadShared(g);
  const m = shared.meshes[0];
  const lod = m.lods[0];
  const v = lod.vertex || m.vertex;
  const n = v.position.length / 3;
  const pos = new Float32Array(v.position);
  const uv = new Float32Array(n * 2);
  if (v.texcoord0?.length) uv.set(v.texcoord0.subarray ? v.texcoord0.subarray(0, n * 2) : v.texcoord0.slice(0, n * 2));
  const nrm = new Int8Array(n * 4), tan = new Int8Array(n * 4);
  const q = (x) => Math.max(-127, Math.min(127, Math.round(x * 127)));
  const pk = v.packedTangentLegacy;
  for (let i = 0; i < n; i++) {
    let N, T, w = 1;
    if (pk?.length) {
      const f = tangent.decodeTangentFrame([pk[i * 4], pk[i * 4 + 1], pk[i * 4 + 2], pk[i * 4 + 3]]);
      N = f.N; T = f.T;
      const c = [N[1] * T[2] - N[2] * T[1], N[2] * T[0] - N[0] * T[2], N[0] * T[1] - N[1] * T[0]];
      w = c[0] * f.B[0] + c[1] * f.B[1] + c[2] * f.B[2] < 0 ? -1 : 1;
    } else if (v.normal?.length) {
      N = [v.normal[i * 3], v.normal[i * 3 + 1], v.normal[i * 3 + 2]];
      T = v.tangent?.length ? [v.tangent[i * 3], v.tangent[i * 3 + 1], v.tangent[i * 3 + 2]] : [1, 0, 0];
    } else { N = [0, 1, 0]; T = [1, 0, 0]; }
    nrm[i * 4] = q(N[0]); nrm[i * 4 + 1] = q(N[1]); nrm[i * 4 + 2] = q(N[2]);
    tan[i * 4] = q(T[0]); tan[i * 4 + 1] = q(T[1]); tan[i * 4 + 2] = q(T[2]); tan[i * 4 + 3] = w * 127;
  }
  const ib = m.indexBuffer ?? lod.indexBuffer;
  const idx = n > 65535 ? new Uint32Array(ib) : new Uint16Array(ib);
  const areas = (lod.areas || []).map((a) => [a.firstElement, a.elementCount]);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const x = pos[i * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  const head = Buffer.from(JSON.stringify({ n, i32: idx instanceof Uint32Array, tris: idx.length / 3, areas, min, max }));
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const parts = [pos, nrm, tan, uv, idx].map((a) => pad(Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  const h = Buffer.alloc(8); h.write('ESM1', 0); h.writeUInt32LE(pad(head).length, 4);
  writeFileSync(file, Buffer.concat([h, pad(head), ...parts]));
  return { n, tris: idx.length / 3, min, max };
}

// ── 材质参数 ──
const PARAMS = ['DiffuseColor', 'FresnelColor', 'Gloss', 'DustDiffuseColor'];
const shaderKind = (p) => { const f = String(p).toLowerCase(); if (!/\/quad\//.test(f)) return null; if (/glass/.test(f)) return 'glass'; if (/heat/.test(f)) return 'heat'; return 'quad'; };
function areaOf(a, forceQuad = false) {
  const e = a.effect || {};
  const kind = forceQuad ? 'quad' : shaderKind(e.effectFilePath);
  if (!kind) return null;
  const cp = Object.fromEntries((e.constParameters || []).map((p) => [p.name, Array.from(p.value || [])]));
  const rs = Object.fromEntries((e.resources || []).map((r) => [r.name, r.resourcePath]));
  const r4 = (x) => (x || [0, 0, 0, 0]).slice(0, 3).map((y) => +(+y).toFixed(5));
  const mtl = [1, 2, 3, 4].map((i) => ({ d: r4(cp[`Mtl${i}DiffuseColor`]), f: r4(cp[`Mtl${i}FresnelColor`]), g: +((cp[`Mtl${i}Gloss`] || [0])[0]).toFixed(4), u: r4(cp[`Mtl${i}DustDiffuseColor`]) }));
  const tex = { a: rs.AlbedoMap, n: rs.NormalMap, r: rs.RoughnessMap, m: rs.MaterialMap, g: rs.GlowMap, d: rs.DirtMap };
  for (const k of Object.keys(tex)) if (!tex[k] || !hasRes(tex[k]) || /\/global\/(black|white|flat|grey)/.test(tex[k])) delete tex[k];
  return { name: a.name, kind, index: a.index ?? 0, count: a.count ?? 1, mtl, glow: r4(cp.GeneralGlowColor), heat: r4(cp.GeneralHeatGlowColor), tex };
}

async function main() {
  await loadIndex();
  gr2 = await import('@carbonenginejs/runtime/resource/formats/gr2');
  cmf = await import('@carbonenginejs/runtime/resource/formats/cmf');
  tangent = await import('@carbonenginejs/runtime/math/tangent');
  const S = await import('@carbonenginejs/runtime/sof');
  const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');
  log('读取 SOF 数据…');
  const black = await CjsBlackFormat.read(new Uint8Array(await getRes('res:/dx9/model/spaceobjectfactory/data.black')));
  const sof = await S.EveSOF.Create({ black: black.object, resFileIndex: [...INDEX.keys()] });
  // --probe 外观DNA：只打印这艘船的喷口参数（不写文件），排查用
  if (args.probe) {
    const v = await sof.BuildValuesFromDNA(String(args.probe));
    const b = v?.boosters || {};
    console.log(JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'items').map(([k, x]) => [k, ArrayBuffer.isView(x) ? Array.from(x) : x])), null, 1));
    console.log('items', JSON.stringify((b.items || []).slice(0, 2)));
    const hd = await sof.GetHullData(String(args.probe).split(':')[0]);
    console.log('hull keys', Object.keys(hd || {}).join(','));
    for (const k of ['children', 'childSets']) console.log(k, JSON.stringify(hd?.[k], (kk, v) => (ArrayBuffer.isView(v) ? undefined : v)).slice(0, 1500));
    for (const k of Object.keys(hd || {})) if (/locator/i.test(k)) console.log(k, JSON.stringify(hd[k], (kk, v) => (ArrayBuffer.isView(v) ? Array.from(v).map((x) => +(+x).toFixed(2)) : v)).slice(0, 1500));
    return;
  }

  // SDE：已发布舰船
  const groups = new Map(jsonl('groups.jsonl').map((g) => [g._key, g]));
  const graphics = new Map(jsonl('graphics.jsonl').map((g) => [g._key, g]));
  // --cats 18,87：只转这些类别（默认舰船 6）；无人机 18、舰载机 87 和舰船用同一套 SOF 外观
  const CATS = new Set(String(args.cats || '6').split(',').map(Number));
  const allTypes = jsonl('types.jsonl');
  // --celestials：星门 / 空间站（按组选，不看 published）
  const CEL = args.celestials ? new Set([10, 15]) : null;
  const celIn = typeof args.celestials === 'string'
    ? new Set(Object.values(JSON.parse(readFileSync(resolve(args.celestials), 'utf8')).systems).flatMap((s) => (s.cel || []).filter((r) => CEL.has(r[1])).map((r) => r[2])))
    : null;
  const ships = CEL
    ? allTypes.filter((t) => CEL.has(t.groupID) && (!celIn || celIn.has(t._key)) && (!ONLY || ONLY.has(t._key)))
    : allTypes.filter((t) => t.published && CATS.has(groups.get(t.groupID)?.categoryID) && (!ONLY || ONLY.has(t._key)));
  // 通用残骸（每个尺寸取一个代表类型就够，外观都一样）
  const WRECK_SIZE = { wreck_s: 's', wreck_m: 'm', wreck_l: 'l' };
  if (args.wrecks) {
    const seen = new Set();
    for (const t of allTypes) {
      const h = t.groupID === 186 ? graphics.get(t.graphicID)?.sofHullName : null;
      if (h && WRECK_SIZE[h] && !seen.has(h)) { seen.add(h); ships.push(t); }
    }
  }
  const byDna = new Map();
  for (const t of ships) {
    const g = graphics.get(t.graphicID);
    if (!g?.sofHullName) continue;
    const dna = `${g.sofHullName}:${g.sofFactionName}:${g.sofRaceName}`;
    if (!byDna.has(dna)) byDna.set(dna, []);
    byDna.get(dna).push(t);
  }
  log('舰船', ships.length, '外观组合', byDna.size);

  const index = existsSync(join(OUT, 'index.json')) ? JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) : { types: {}, models: {} };
  const geoDone = new Map();
  const locCache = new Map();
  const texJobs = new Map();
  let ok = 0, bad = 0;
  for (const [dna, types] of byDna) {
    const key = dna.replace(/:/g, '.');
    try {
      const v = await sof.BuildValuesFromDNA(dna);
      const geo = v?.mesh?.geometryResPath;
      if (!geo || !hasRes(geo)) throw new Error('没有几何 ' + geo);
      const hull = dna.split(':')[0];
      if (!geoDone.has(geo)) {
        const file = join(OUT, 'g', hull + '.bin');
        geoDone.set(geo, existsSync(file) ? JSON.parse(readFileSync(file).subarray(8, 8 + readFileSync(file).readUInt32LE(4)).toString().trim().replace(/\0+$/, '')) : await writeGeometry(geo, file));
      }
      const areas = [...(v.mesh.opaqueAreas || []), ...(v.mesh.transparentAreas || [])].map(areaOf).filter(Boolean);
      for (const a of areas) {
        const set = JSON.stringify(a.tex);
        const tk = md5(set);
        if (!texJobs.has(tk)) texJobs.set(tk, a.tex);
        a.tex = { k: tk, has: Object.keys(a.tex).join('') };
      }
      // 喷口：[x, y, z, 口径, 长度, 渐变行0, 渐变行1, 有尾迹]
      const boosters = (v.boosters?.items || []).map((b) => { const m = b.transform; return [m[12], m[13], m[14], Math.hypot(m[0], m[1], m[2]), Math.hypot(m[8], m[9], m[10])].map((x) => +x.toFixed(2)).concat(b.atlasIndex0 || 0, b.atlasIndex1 || 0, b.hasTrail ? 1 : 0); });
      // 喷口外观（SOF EveBoosterSet2）：两层火焰颜色（HDR）、光点 / 横向光晕、尾迹、跃迁时颜色
      const BS = v.boosters || {};
      const cpOf = (e) => Object.fromEntries((e?.constParameters || []).map((p) => [p.name, Array.from(p.value || []).map((x) => +(+x).toFixed(4))]));
      const rgb = (c) => Array.from(c || [0, 0, 0]).slice(0, 3).map((x) => +(+x).toFixed(5));
      const be = cpOf(BS.effect), te = cpOf(BS.trails?.effect);
      const bst = { c0: rgb(be.Color0), c1: rgb(be.Color1), a0: rgb(be.NoiseAmplitudeStart0), a1: rgb(be.NoiseAmplitudeEnd0), fq: (be.NoiseFrequency0 || [0, 0, 0, 0]).slice(0, 4), wc0: rgb(be.WarpColor0), wc1: rgb(be.WarpColor1), ns: [(be.NoiseSpeed0 || [0])[0], (be.NoiseSpeed1 || [0])[0]],
        glow: [+BS.glowScale || 0, ...rgb(BS.glowColor)], halo: [+BS.haloScaleX || 0, +BS.haloScaleY || 0, ...rgb(BS.haloColor)], sym: +BS.symHaloScale || 0,
        wglow: rgb(BS.warpGlowColor), whalo: rgb(BS.warpHaloColor), trail: te.TrailSize || null, trailC: te.TrailColor ? rgb(te.TrailColor) : null, on: BS.alwaysOn ? 1 : 0 };
      const hd = await sof.GetHullData(hull);
      // 船体定位点（受损火焰 vds_trail、受击点 damage）：SOF 数据里是空的，在船体自己的 .black 里；这里先下载，全部模型写完后统一读（hull-locators.mjs）
      const loc = {};
      const hullBlack = `res:/dx9/model/spaceobjectfactory/hulls/${hull}.black`;
      if (!locCache.has(hull)) {
        let file = '';
        if (hasRes(hullBlack)) { try { await getRes(hullBlack); file = cacheFile(hullBlack); } catch (e) { log('船体文件下载失败', hull, e.message); } }
        locCache.set(hull, { file, keys: [] });
      }
      locCache.get(hull).keys.push(key);
      const model = {
        dna, geo: `g/${hull}.bin`, r: +(+v.boundingSphereRadius).toFixed(1), c: Array.from(v.boundingSphereCenter || [0, 0, 0]).map((x) => +(+x).toFixed(1)),
        areas, boosters, bst, loc, boosterColor: Array.from(v.boosters?.glowColor || [0.01, 0.02, 0.03]).slice(0, 3), cat: hd?.category || '',
        // 护盾外形椭球（SOF 船体 shapeEllipsoidCenter / Radius，客户端护盾受击特效贴在它上面）：[中心 xyz, 半轴 xyz]，米，船体坐标
        se: hd?.shapeEllipsoidRadius ? [...Array.from(hd.shapeEllipsoidCenter || [0, 0, 0]), ...Array.from(hd.shapeEllipsoidRadius)].map((x) => +(+x).toFixed(1)) : null,
      };
      writeFileSync(join(OUT, 'm', key + '.json'), JSON.stringify(model));
      index.models[key] = { r: model.r };
      if (WRECK_SIZE[hull]) { (index.wrecks ||= {})[WRECK_SIZE[hull]] = key; ok++; continue; }
      if (CEL) { for (const t of types) (index.cel ||= {})[t._key] = key; ok++; continue; }
      for (const t of types) index.types[t._key] = { m: key, b: bracketOf(groups.get(t.groupID)?.name?.en, model.cat) };
      ok++;
      if (ok % 20 === 0) log('模型', ok, '/', byDna.size);
    } catch (e) {
      bad++;
      log('跳过', dna, e.message);
    }
  }
  log('几何完成', ok, '失败', bad, '贴图组', texJobs.size);
  // 定位点：一次读完，写回各模型
  {
    const jobs = Object.fromEntries([...locCache].filter(([, v]) => v.file).map(([h, v]) => [h, v.file]));
    const r = spawnSync(process.execPath, [join(HERE, 'hull-locators.mjs')], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 28, cwd: HERE });
    if (r.status !== 0) log('定位点读取出错', (r.stderr || '').slice(0, 500));
    else {
      if (r.stderr) log('定位点：部分船体读取失败', r.stderr.trim().split('\n').length, '个，例如', r.stderr.trim().split('\n')[0].slice(0, 200));
      const got = JSON.parse(r.stdout || '{}');
      let n = 0;
      for (const [h, v] of locCache) {
        if (!got[h] || !Object.keys(got[h]).length) continue;
        for (const k of v.keys) { const f = join(OUT, 'm', k + '.json'); const m = JSON.parse(readFileSync(f, 'utf8')); m.loc = got[h]; writeFileSync(f, JSON.stringify(m)); n++; }
      }
      log('定位点写入', n, '个外观');
    }
  }

  // 炮塔模型（EveTurretSet）：几何 + quadv5 材质（Mtl1~4 颜色 / 光泽、发光色）照船体一样转，挂点在船体 loc.turrets
  if (args.turrets) {
    const tByPath = new Map();
    for (const t of allTypes) {
      if (!t.published || groups.get(t.groupID)?.categoryID !== 7) continue;
      const gf = String(graphics.get(t.graphicID)?.graphicFile || '').toLowerCase();
      if (!gf.includes('/model/turret/')) continue;
      const bp = gf.replace(/\.red$/, '.black');
      if (!tByPath.has(bp)) tByPath.set(bp, []);
      tByPath.get(bp).push(t._key);
    }
    let tn = 0;
    index.turrets = index.turrets || {};
    const tFiles = {};
    await pool([...tByPath.keys()].filter(hasRes), 6, async (bp) => { try { await getRes(bp); tFiles[bp] = cacheFile(bp); } catch (e) { log('炮塔文件下载失败', bp, e.message); } });
    const tr = spawnSync(process.execPath, [join(HERE, 'turret-sets.mjs')], { input: JSON.stringify(tFiles), encoding: 'utf8', maxBuffer: 1 << 28, cwd: HERE });
    if (tr.stderr) log('炮塔文件读取：', tr.stderr.trim().split('\n').length, '个失败，例如', tr.stderr.trim().split('\n')[0].slice(0, 200));
    const tSets = tr.status === 0 ? JSON.parse(tr.stdout || '{}') : {};
    for (const [bp, ids] of tByPath) {
      try {
        if (!hasRes(bp)) throw new Error('没有 ' + bp);
        const ts = tSets[bp];
        if (ts?.type !== 'EveTurretSet') throw new Error('不是 EveTurretSet：' + ts?.type);
        const geo = ts.geometryResPath;
        if (!geo || !hasRes(geo)) throw new Error('没有几何 ' + geo);
        // 同名文件在 s / m / l 目录各有一份（如 blast_neutron_t1），键里带上 model/turret/ 之后的整段路径
        const key = 'turret_' + bp.split('/model/turret/')[1].replace(/\.black$/, '').replace(/\//g, '_');
        const file = join(OUT, 'g', key + '.bin');
        const gi = existsSync(file) ? null : await writeGeometry(geo, file);
        const head = gi || JSON.parse(readFileSync(file).subarray(8, 8 + readFileSync(file).readUInt32LE(4)).toString().trim().replace(/\0+$/, ''));
        const nAreas = Math.max(1, (head.areas || [0]).length);
        const a = areaOf({ name: 'turret', effect: ts.effect, index: 0, count: nAreas }, true);
        if (!a) throw new Error('材质读不了');
        const set = JSON.stringify(a.tex), tk = md5(set);
        if (!texJobs.has(tk)) texJobs.set(tk, a.tex);
        a.tex = { k: tk, has: Object.keys(a.tex).join('') };
        const bs = Array.from(ts.boundingSphere || [0, 0, 0, 1]).map((x) => +(+x).toFixed(2));
        const model = { geo: `g/${key}.bin`, r: bs[3], c: bs.slice(0, 3), areas: [a], boosters: [], bst: null, loc: {}, boosterColor: [0, 0, 0], cat: 'turret',
          pitchMin: +ts.sysBonePitchMin || 0, clip: +(+ts.bottomClipHeight || 0).toFixed(3), fx: String(ts.firingEffectResPath || '').toLowerCase() };
        writeFileSync(join(OUT, 'm', key + '.json'), JSON.stringify(model));
        index.models[key] = { r: model.r };
        for (const id of ids) index.turrets[id] = key;
        tn++;
      } catch (e) { log('炮塔跳过', bp, e.message); }
    }
    log('炮塔模型', tn, '/', tByPath.size);
  }

  // 贴图：分批下载 → textures.py 转 WebP → 删除缓存的 DDS
  const todo = [...texJobs].filter(([k]) => !existsSync(join(OUT, 't', k + '_x.webp')));
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    const jobs = [];
    const paths = [];
    await pool(batch, 6, async ([k, tex]) => {
      const src = {};
      for (const [c, p] of Object.entries(tex)) { try { await getRes(p); src[c] = cacheFile(p); paths.push(src[c]); } catch (e) { log('贴图下载失败', p, e.message); } }
      if (src.a) jobs.push({ out: join(OUT, 't', k + '_a.webp'), kind: 'a', src, max: MAX });
      if (src.n) jobs.push({ out: join(OUT, 't', k + '_n.webp'), kind: 'n', src, max: MAX });
      jobs.push({ out: join(OUT, 't', k + '_x.webp'), kind: 'x', src, max: MAX });
    });
    const r = spawnSync('python3', ['-I', join(HERE, 'textures.py')], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.status !== 0) log('贴图转换出错', r.stderr.slice(0, 500));
    else if (r.stderr) log(r.stderr.trim().slice(0, 500));
    if (!args['keep-cache']) for (const p of paths) rmSync(p, { force: true });
    log('贴图', Math.min(i + 12, todo.length), '/', todo.length);
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
  let size = 0;
  for (const d of ['g', 't', 'm']) for (const f of (await import('node:fs')).readdirSync(join(OUT, d))) size += statSync(join(OUT, d, f)).size;
  log('完成：', Object.keys(index.types).length, '种舰船，', Object.keys(index.models).length, '个外观，共', (size / 1e6).toFixed(0), 'MB →', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
