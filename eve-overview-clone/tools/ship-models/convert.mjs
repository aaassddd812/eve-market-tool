// 舰船模型转换：EVE 客户端资源服务器 → 战场模拟用的静态文件（ship-models/）
//
// 用法：node --max-old-space-size=6000 convert.mjs --sde <SDE 目录> [--out <输出目录>] [--only 587,24690] [--max 2048] [--keep-cache]
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
const CACHE = join(HERE, '.cache');
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
  const build = JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
  const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
  const want = app.split('\n').map((l) => l.split(',')).filter((p) => p[0] === 'app:/resfileindex.txt');
  for (const [, path] of want) {
    for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) {
      const p = l.split(',');
      if (p[1]) INDEX.set(p[0].toLowerCase(), p[1]);
    }
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
function areaOf(a) {
  const e = a.effect || {};
  const kind = shaderKind(e.effectFilePath);
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

  // SDE：已发布舰船
  const groups = new Map(jsonl('groups.jsonl').map((g) => [g._key, g]));
  const graphics = new Map(jsonl('graphics.jsonl').map((g) => [g._key, g]));
  const ships = jsonl('types.jsonl').filter((t) => t.published && groups.get(t.groupID)?.categoryID === 6 && (!ONLY || ONLY.has(t._key)));
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
      const boosters = (v.boosters?.items || []).map((b) => { const m = b.transform; return [m[12], m[13], m[14], Math.hypot(m[0], m[1], m[2]), Math.hypot(m[8], m[9], m[10])].map((x) => +x.toFixed(2)); });
      const hd = await sof.GetHullData(hull);
      const model = {
        dna, geo: `g/${hull}.bin`, r: +(+v.boundingSphereRadius).toFixed(1), c: Array.from(v.boundingSphereCenter || [0, 0, 0]).map((x) => +(+x).toFixed(1)),
        areas, boosters, boosterColor: Array.from(v.boosters?.glowColor || [0.01, 0.02, 0.03]).slice(0, 3), cat: hd?.category || '',
      };
      writeFileSync(join(OUT, 'm', key + '.json'), JSON.stringify(model));
      index.models[key] = { r: model.r };
      for (const t of types) index.types[t._key] = { m: key, b: bracketOf(groups.get(t.groupID)?.name?.en, model.cat) };
      ok++;
      if (ok % 20 === 0) log('模型', ok, '/', byDna.size);
    } catch (e) {
      bad++;
      log('跳过', dna, e.message);
    }
  }
  log('几何完成', ok, '失败', bad, '贴图组', texJobs.size);

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
    const r = spawnSync('python3', [join(HERE, 'textures.py')], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 26 });
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
