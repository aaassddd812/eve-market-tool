// 舰船模型转换：EVE 客户端资源服务器 → 战场模拟用的静态文件（ship-models/）
//
// 用法：node --max-old-space-size=6000 convert.mjs --sde <SDE 目录> [--out <输出目录>] [--only 587,24690] [--cats 6,18,87] [--build 3628513] [--max 2048] [--keep-cache] [--wrecks] [--turrets]
//   --wrecks：另外转通用残骸 wreck_s / wreck_m / wreck_l（SDE 残骸组 186：护卫舰级 s、驱逐 ~ 巡洋 m、战巡 ~ 战列 l），index.wrecks 记 { s, m, l: 模型键 }
//   --turrets：另外转炮塔 / 发射器模型（装备 graphicFile 在 model/turret/ 下的 EveTurretSet），index.turrets 记 { 装备 typeID: 模型键 }
//   --celestials [pilot-systems.json]：不转舰船，改转星门（组 10）/ 空间站（组 15）。这些类型 SDE 里 published=false，所以不看 published；
//     客户端 station.py / stargate.py 和舰船一样按 graphicID 拼 SOF DNA。给了 pilot-systems.json 就只转里面出现的类型（可再加 --only）；
//     index.cel 记 { typeID: 模型键 }（不进 index.types，免得被当成舰船）。模型半径 2–60 km，贴图建议 --max 1024
//     例：node --max-old-space-size=6000 convert.mjs --celestials ../../pilot-systems.json --max 1024 --cache <新建的空目录>
//   --npc <npc-data.json>：不转舰船，改转驾驶模拟场景里的 NPC（舰船、岗哨、建筑；SDE 里 published=false，不看 published），
//     NPC 用的也是 SOF 船体（graphicID → hull:faction:race），进 index.types；加速轨道 / 导管（组 366）进 index.cel。
//     --gates 17831,47685：另外加上这些加速轨道类型（死亡空间的门在场景里没写类型，用通用的 17831）
//     例：node --max-old-space-size=6000 convert.mjs --npc ../../npc-data.json --gates 17831 --max 1024 --cache <新建的空目录>
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

// ── 船体灯（客户端 Tr2LightManager 的点光 / 聚光灯，SOF 搭船时挂上的）──
// 来源：船体灯组（hullLightSets → Tr2PointLight / Tr2SpotLight）、精灵组 / 聚光灯组 / 面片组 / 精灵线 / 光雾挂件上的灯（横幅灯颜色运行时取横幅图，不导）。
// 每盏一行：[x, y, z（船体坐标，米）, 半径, 内半径, r, g, b（颜色 × 亮度，未乘半径）, 方向 xyz（聚光灯：旋转 × (0, 0, −1)）, cos 外角, cos 内角（点光 0）, 类型, 参数 ×4]
//   类型 0 常亮；1 精灵闪烁：半径、内半径 × Blink(频率, 相位, 最小, 最大)；2 面片渐变：亮度 × Fade(类型, 频率, 相位)；3 亮度 × 推进器增益（boosterGainInfluence）
//   只要照表面的（flags & 1，AFFECTS_SURFACES）；噪声闪动（noiseAmplitude）全部数据都是 0，不导
const avgColor = new Map();
async function texAverage(path) {
  // 面片组灯色 × 四张贴图的平均色（TriTextureRes::GetAverageColor；没贴图 = 1）
  if (!path) return [1, 1, 1];
  const k = path.toLowerCase();
  if (!avgColor.has(k)) {
    let c = [1, 1, 1];
    if (hasRes(k)) {
      try {
        await getRes(k);
        const r = spawnSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]).convert("RGB")\nh = im.histogram()\nn = im.size[0] * im.size[1]\nprint(*[sum(i * h[c * 256 + i] for i in range(256)) / n / 255 for c in range(3)])', cacheFile(k)], { encoding: 'utf8' });
        if (r.status === 0) c = r.stdout.trim().split(/\s+/).map(Number);
        else log('贴图平均色读取失败', k, (r.stderr || '').slice(-200));
      } catch (e) { log('贴图平均色下载失败', k, e.message); }
    }
    avgColor.set(k, c);
  }
  return avgColor.get(k);
}
const saturateColor = (c, s) => { if (s === 1) return c; const g = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114; return c.map((x) => g + (x - g) * Math.max(0, s)); };
function quatDir(q) {   // 旋转 (0, 0, −1)
  const [x, y, z, w] = Array.from(q || [0, 0, 0, 1]);
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
// IES 灯型（Tr2LightProfileRes）：1024×1 R16F 的 .dds，横坐标 u = 0.5 − 0.5·cos(与灯轴夹角)；这里降到 128 点
async function iesProfile(path) {
  try {
    if (!hasRes(path)) return null;
    const b = Buffer.from(await getRes(path));
    if (b.toString('latin1', 0, 4) !== 'DDS ') return null;
    const off = b.toString('latin1', 84, 88) === 'DX10' ? 148 : 128;
    const w = b.readUInt32LE(16), hh = b.readUInt32LE(12);
    if (w !== 1024 || hh !== 1) { log('IES 尺寸不对', path, w, hh); return null; }
    const half = (u) => { const e = (u >> 10) & 31, f = u & 1023, sg = u >> 15 ? -1 : 1; return sg * (e === 0 ? f / 1024 * 2 ** -14 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15)); };
    const out = [];
    for (let i = 0; i < 128; i++) { let a = 0; for (let k = 0; k < 8; k++) a += half(b.readUInt16LE(off + (i * 8 + k) * 2)); out.push(+(a / 8).toFixed(4)); }
    return out;
  } catch (e) { log('IES 读取失败', path, e.message); return null; }
}
async function lightsOf(v) {
  const ids = new Map();
  const walk = (o) => { if (!o || typeof o !== 'object' || ArrayBuffer.isView(o)) return; if (o._id != null) ids.set(o._id, o); for (const x of Object.values(o)) walk(x); };
  walk(v);
  const deref = (p) => (p && p._ref != null ? ids.get(p._ref) : p);
  const out = [];
  const push = (d, kind = 0, prm = [0, 0, 0, 0], mul = null, sat = 1) => {
    if (!d || !((d.flags ?? 1) & 1)) return;
    let c = Array.from(d.color || [0, 0, 0]).slice(0, 3).map(Number);
    if (mul) c = c.map((x, i) => x * mul[i]);
    c = saturateColor(c, sat).map((x) => x * Number(d.brightness ?? 1));
    const R = Number(d.radius) || 0;
    if (!(R > 0) || Math.max(...c) <= 0) return;
    const spot = Number(d.outerAngle) > 0;
    const p = Array.from(d.position || [0, 0, 0]);
    out.push([...p, R, Number(d.innerRadius) || 0, ...c, ...(spot ? quatDir(d.rotation) : [0, 0, 0]),
      spot ? Math.cos(d.outerAngle * Math.PI / 180) : 0, spot ? Math.cos((d.innerAngle || 0) * Math.PI / 180) : 0, kind, ...prm].map((x) => +(+x).toFixed(4)));
  };
  for (const L of v.lights || []) push(L.lightData || L);
  for (const at of v.attachments || []) {
    const ls = at.lights || [];
    if (!ls.length) continue;
    if (at._type === 'EveSpriteSet' || at._type === 'EveSpriteLineSet') for (const L of ls) push(L.lightData, 1, [L.blinkRate || 0, L.blinkPhase || 0, L.minScale ?? 1, L.maxScale ?? 1]);
    else if (at._type === 'EveSpotlightSet' || at._type === 'EveHazeSet') for (const L of ls) push(L.lightData, L.boosterGainInfluence ? 3 : 0);
    else if (at._type === 'EvePlaneSet') {
      const avg = [1, 1, 1];
      for (const p of [at.layerMap1Parameter, at.layerMap2Parameter, at.imageMapParameter, at.maskMapParameter]) {
        const a = await texAverage(deref(p)?.resourcePath);
        for (let i = 0; i < 3; i++) avg[i] *= a[i];
      }
      for (const L of ls) push(L.lightData, L.fadeType ? 2 : 0, [L.fadeType || 0, L.blinkRate || 0, L.blinkPhase || 0, 0], avg, L.saturation ?? 1);
    }
  }
  return out;
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
  const mtl = [1, 2, 3, 4].map((i) => ({ d: r4(cp[`Mtl${i}DiffuseColor`]), f: r4(cp[`Mtl${i}FresnelColor`]), g: +((cp[`Mtl${i}Gloss`] || [0])[0]).toFixed(4), u: r4(cp[`Mtl${i}DustDiffuseColor`]), ...(cp[`Mtl${i}HeatGlowData`] ? { h: cp[`Mtl${i}HeatGlowData`].slice(0, 4).map((y) => +(+y).toFixed(5)) } : {}) }));   // h：推进器区（quadheatv5）热光参数
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
  // --lights-stats：统计所有船体 SOF 里带灯（light / bannerLight）的挂件
  if (args['lights-stats']) {
    const st = {}; const ex = {};
    for (const n of sof.dataMgr.ListHullDataNames()) {
      const hd = await sof.GetHullData(n);
      for (const k of ['spriteSets', 'hullLightSets', 'spotlightSets', 'planeSets', 'spriteLineSets', 'hazeSets']) for (const set of hd?.[k] || []) for (const it of set.items || []) {
        const L = it.light || it.lights?.length;
        st[k] ||= { items: 0, lit: 0, hulls: new Set() }; st[k].items++;
        if (L) { st[k].lit++; st[k].hulls.add(n); ex[k] ||= JSON.stringify(it, (kk, v) => (ArrayBuffer.isView(v) ? Array.from(v).map((x) => +(+x).toFixed(3)) : v)).slice(0, 800); }
      }
      if ((hd?.hullLightSets || []).some((s) => s.items?.length)) { st.hls ||= { n: 0, hulls: new Set() }; st.hls.n++; st.hls.hulls.add(n); ex.hls ||= JSON.stringify(hd.hullLightSets, (kk, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)).slice(0, 1500); }
    }
    for (const [k, v] of Object.entries(st)) console.log(k, v.items, v.lit, v.hulls?.size, v.n, [...(v.hulls || [])].slice(0, 12).join(' '));
    console.log(JSON.stringify(ex, null, 1));
    return;
  }
  // --child-stats：统计所有船体子特效（children 总是挂的 + childSets primary）里的灯（只下载 .black，不写模型；不代阵营色，颜色不准，只看数量）
  if (args['child-stats']) {
    const jobs = {};
    const names = sof.dataMgr.ListHullDataNames();
    await pool(names, 8, async (n) => {
      const hd = await sof.GetHullData(n);
      const items = [...(hd?.children || []).filter((c) => (c.groupIndex ?? -1) === -1), ...(hd?.childSets || []).filter((cs) => cs.visibilityGroupName === 'primary').flatMap((cs) => cs.items || [])];
      const seenC = new Set(), files = [];
      for (const it of items) {
        const bp = String(it.redFilePath || '').toLowerCase().replace(/\.red$/, '.black');
        const t = Array.from(it.translation || [0, 0, 0]), r = Array.from(it.rotation || [0, 0, 0, 1]), sc = Array.from(it.scaling || [1, 1, 1]);
        const sig = bp + JSON.stringify([t, r, sc]);
        if (!bp || seenC.has(sig) || !hasRes(bp)) continue;
        seenC.add(sig);
        try { await getRes(bp); files.push({ file: cacheFile(bp), t, r, s: sc }); } catch (e) { log('子特效下载失败', bp, e.message); }
      }
      if (files.length) jobs[n] = { files, cs: [] };
    });
    const r = spawnSync(process.execPath, [join(HERE, 'child-lights.mjs')], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 30, cwd: HERE });
    if (r.stderr) log('读取失败', r.stderr.trim().split('\n').length, r.stderr.trim().split('\n')[0].slice(0, 200));
    const got = JSON.parse(r.stdout || '{}');
    const hulls = {}, types = {}, unh = {}, ies = new Set(); let lights = 0, noise = 0, anim = 0, spot = 0, nodes = 0; const animH = {};
    for (const [h, g] of Object.entries(got)) {
      for (const [t, c] of Object.entries(g.types)) types[t] = (types[t] || 0) + c;
      for (const [t, c] of Object.entries(g.unhandled || {})) unh[t] = (unh[t] || 0) + c;
      for (const L of g.lights) { lights++; if (L.na) noise++; if (L.a) anim++; if (L.dir) spot++; if (L.ies) ies.add(L.ies); }
      nodes += g.graph?.n.length || 0;
      if (g.lights.length) hulls[h] = g.lights.length;
      if (g.lights.some((L) => L.a)) animH[h] = g.lights.filter((L) => L.a).length;
    }
    console.log(JSON.stringify({ hullsTotal: names.length, hullsWithChildLights: Object.keys(hulls).length, lights, spot, noise, anim, graphNodes: nodes, iesProfiles: ies.size, types, unhandled: unh }));
    writeFileSync(join(OUT, '..', 'child-light-hulls.json'), JSON.stringify({ hulls, animH }));
    return;
  }
  // --probe 外观DNA：只打印这艘船的喷口参数（不写文件），排查用
  if (args.probe) {
    const v = await sof.BuildValuesFromDNA(String(args.probe));
    const b = v?.boosters || {};
    console.log(JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'items').map(([k, x]) => [k, ArrayBuffer.isView(x) ? Array.from(x) : x])), null, 1));
    console.log('items', JSON.stringify((b.items || []).slice(0, 2)));
    const hd = await sof.GetHullData(String(args.probe).split(':')[0]);
    console.log('hull keys', Object.keys(hd || {}).join(','));
    for (const k of ['children', 'childSets']) console.log(k, JSON.stringify(hd?.[k], (kk, v) => (ArrayBuffer.isView(v) ? undefined : v)).slice(0, 1500));
    if (args.mat) for (const a of [...(v.mesh?.opaqueAreas || []), ...(v.mesh?.transparentAreas || [])]) console.log(a.name, a.effect?.effectFilePath, JSON.stringify((a.effect?.constParameters || []).map((x) => [x.name, Array.from(x.value || []).map((y) => +(+y).toFixed(4))])), JSON.stringify((a.effect?.resources || []).map((r) => [r.name, r.resourcePath])));
    if (args.lights) console.log('LIGHTS', JSON.stringify(await lightsOf(v)).slice(0, 3000));
    if (args.lights) for (const k of ['spriteSets', 'hullLightSets', 'spotlightSets', 'planeSets', 'spriteLineSets', 'hazeSets', 'bannerSets', 'banners']) console.log('LIGHT', k, JSON.stringify(hd?.[k], (kk, v) => (ArrayBuffer.isView(v) ? Array.from(v).map((x) => +(+x).toFixed(3)) : v)).slice(0, 3000));
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
  // --npc：场景 NPC + 加速轨道
  const NPC = args.npc ? new Set([...Object.keys(JSON.parse(readFileSync(resolve(args.npc), 'utf8')).npc).map(Number), ...String(args.gates || '').split(',').filter(Boolean).map(Number)]) : null;
  const GATE_GROUP = 366;
  const ships = NPC
    ? allTypes.filter((t) => NPC.has(t._key) && (!ONLY || ONLY.has(t._key)))
    : CEL
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
  const childCache = new Map();   // 船体 → { jobs: [{ file, t, r, s }], keys: [外观键] }：子特效（.red / .black）里的灯，全部模型写完后统一读（child-lights.mjs）
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
      const areas = [...(v.mesh.opaqueAreas || []), ...(v.mesh.transparentAreas || [])].map((a) => areaOf(a)).filter(Boolean);   // 不能直接 .map(areaOf)：下标会被当成 forceQuad
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
      // 子特效：船体 children 里 groupIndex −1（总是挂）的 + childSets 里 visibilityGroupName 为 primary（默认可见组）的，同一文件同一变换只算一次
      if (!childCache.has(hull)) {
        const items = [...(hd?.children || []).filter((c) => (c.groupIndex ?? -1) === -1), ...(hd?.childSets || []).filter((cs) => cs.visibilityGroupName === 'primary').flatMap((cs) => cs.items || [])];
        const jobs = [], seenC = new Set();
        for (const it of items) {
          const bp = String(it.redFilePath || '').toLowerCase().replace(/\.red$/, '.black');
          const t = Array.from(it.translation || [0, 0, 0]), r = Array.from(it.rotation || [0, 0, 0, 1]), sc = Array.from(it.scaling || [1, 1, 1]);
          const sig = bp + JSON.stringify([t, r, sc]);
          if (!bp || seenC.has(sig) || !hasRes(bp)) continue;
          seenC.add(sig);
          try { await getRes(bp); jobs.push({ file: cacheFile(bp), t, r, s: sc }); } catch (e) { log('子特效下载失败', bp, e.message); }
        }
        childCache.set(hull, { jobs, keys: [] });
      }
      childCache.get(hull).keys.push([key, dna]);
      const lights = await lightsOf(v);
      // 推进器灯（EveBoosterSet2::Add / EveBoosterUtilities AddBoosterLights）：每个喷口一盏点光，位置 = 喷口矩阵 × (0, 0, −lightOffset)，
      //   基础半径 = max(|X 轴|, |Y 轴|) × lightScale；运行时 半径 × lerp(lightRadius, lightWarpRadius, 跃迁) × 推进强度，颜色 lerp(lightColor, lightWarpColor, 跃迁) × 闪动
      //   行：kind 4，p0 = 相位（客户端 GenerateBoosterLightPhase 是 128 × rand；这里由外观键 + 序号哈希出来，重跑不变）
      let bl = null;
      if ((+BS.lightRadius > 0 || +BS.lightWarpRadius > 0) && (BS.items || []).length) {
        bl = { r: +BS.lightRadius || 0, c: rgb(BS.lightColor), wr: +BS.lightWarpRadius || 0, wc: rgb(BS.lightWarpColor), fa: +(+BS.lightFlickerAmplitude || 0).toFixed(4), ff: +(+BS.lightFlickerFrequency || 0).toFixed(4) };
        const off = +BS.lightOffset || 0;
        for (const [bi, b] of BS.items.entries()) {
          const m = b.transform;
          const p = [m[12] - m[8] * off, m[13] - m[9] * off, m[14] - m[10] * off];
          const R = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6])) * (b.lightScale ?? 1);
          if (R > 0) lights.push([...p, R, 0, 1, 1, 1, 0, 0, 0, 0, 0, 4, (parseInt(md5(key + bi).slice(0, 6), 16) / 0xffffff) * 128, 0, 0, 0].map((x) => +(+x).toFixed(4)));
        }
      }
      const model = {
        dna, geo: `g/${hull}.bin`, r: +(+v.boundingSphereRadius).toFixed(1), c: Array.from(v.boundingSphereCenter || [0, 0, 0]).map((x) => +(+x).toFixed(1)),
        areas, boosters, bst, loc, boosterColor: Array.from(v.boosters?.glowColor || [0.01, 0.02, 0.03]).slice(0, 3), cat: hd?.category || '',
        // 护盾外形椭球（SOF 船体 shapeEllipsoidCenter / Radius，客户端护盾受击特效贴在它上面）：[中心 xyz, 半轴 xyz]，米，船体坐标
        se: hd?.shapeEllipsoidRadius ? [...Array.from(hd.shapeEllipsoidCenter || [0, 0, 0]), ...Array.from(hd.shapeEllipsoidRadius)].map((x) => +(+x).toFixed(1)) : null,
        ...(lights.length ? { lights } : {}), ...(bl ? { bl } : {}),
      };
      writeFileSync(join(OUT, 'm', key + '.json'), JSON.stringify(model));
      index.models[key] = { r: model.r };
      if (WRECK_SIZE[hull]) { (index.wrecks ||= {})[WRECK_SIZE[hull]] = key; ok++; continue; }
      if (CEL) { for (const t of types) (index.cel ||= {})[t._key] = key; ok++; continue; }
      if (NPC) {
        for (const t of types) {
          if (t.groupID === GATE_GROUP) (index.cel ||= {})[t._key] = key;
          else index.types[t._key] = { m: key, b: bracketOf(groups.get(t.groupID)?.name?.en, model.cat), npc: 1 };
        }
        ok++;
        continue;
      }
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
  // 子特效里的灯（child-lights.mjs：换算到船体坐标、按阵营色表求颜色、曲线动画）：
  //   有噪声的是 kind 5（p0..p2 = noiseAmplitude、noiseFrequency、noiseOctaves）；带 IES 灯型的在第 19 列放 m.ies 里的序号 + 1
  //   （m.ies：[[路径, 128 点强度]]，点 i 对应 u = (i + 0.5)/128，u = 0.5 − 0.5·cos）；
  //   颜色 / 亮度 / 半径随曲线变的灯另记在 m.anim：{ sets, n（js/sim-curves.js 的绑定图）, la: [[行号, 绑定, 静态色, 静态亮度, 静态半径, 静态内半径, parentScale]] }
  {
    const csCache = new Map(), jobs = {};
    for (const [, v] of childCache) {
      if (!v.jobs.length) continue;
      for (const [k, dna] of v.keys) {
        if (!csCache.has(dna)) { let cs = []; try { cs = ((await sof.CreateDna(dna))?.GetColorSet() || []).map((c) => Array.from(c || [0, 0, 0, 0]).map(Number)); } catch (e) { log('阵营色表读取失败', dna, e.message); } csCache.set(dna, cs); }
        jobs[k] = { files: v.jobs, cs: csCache.get(dna) };
      }
    }
    const r = Object.keys(jobs).length ? spawnSync(process.execPath, [join(HERE, 'child-lights.mjs')], { input: JSON.stringify(jobs), encoding: 'utf8', maxBuffer: 1 << 30, cwd: HERE }) : { status: 0, stdout: '{}' };
    if (r.status !== 0) log('子特效灯读取出错', (r.stderr || '').slice(0, 500));
    else {
      if (r.stderr) log('子特效灯：部分文件读取失败', r.stderr.trim().split('\n').length, '个，例如', r.stderr.trim().split('\n')[0].slice(0, 200));
      const got = JSON.parse(r.stdout || '{}');
      const iesCache = new Map();
      const st = { models: 0, lights: 0, anim: 0, noise: 0, ies: 0, types: {}, unhandled: {} };
      for (const [k, g] of Object.entries(got)) {
        const f = join(OUT, 'm', k + '.json');
        if (!existsSync(f)) continue;
        for (const [t, c] of Object.entries(g.types)) st.types[t] = (st.types[t] || 0) + c;
        for (const [t, c] of Object.entries(g.unhandled || {})) st.unhandled[t] = (st.unhandled[t] || 0) + c;
        const m = JSON.parse(readFileSync(f, 'utf8'));
        // 上面这次已重写过模型文件（只含 SOF 挂件的灯和推进器灯），子特效的灯接在后面
        const rows = m.lights || [], ies = [], la = [];
        let added = 0;
        for (const L of g.lights) {
          if (!(L.R > 0) || (!L.a && Math.max(...L.c) <= 0)) continue;
          let pi = 0;
          if (L.ies && L.dir) {
            if (!iesCache.has(L.ies)) iesCache.set(L.ies, await iesProfile(L.ies));
            const prof = iesCache.get(L.ies);
            if (prof) { let at = ies.findIndex((x) => x[0] === L.ies); if (at < 0) at = ies.push([L.ies, prof]) - 1; pi = at + 1; st.ies++; }
          }
          const noise = L.na !== 0;
          if (noise) st.noise++;
          const row = [...L.p, L.R, L.ri, ...L.c, ...(L.dir || [0, 0, 0]), L.co, L.ci, noise ? 5 : 0, ...(noise ? [L.na, L.nf, L.no, 0] : [0, 0, 0, 0])];
          if (pi) row.push(pi);
          if (L.a) { la.push([rows.length, L.a.b, L.a.c0, L.a.br0, L.a.R0, L.a.ri0, L.a.ps]); st.anim++; }
          rows.push(row.map((x) => +(+x).toFixed(4)));
          added++;
        }
        if (!added) continue;
        st.models++; st.lights += added;
        m.lights = rows;
        if (ies.length) m.ies = ies;
        if (la.length && g.graph) m.anim = { ...g.graph, la };
        writeFileSync(f, JSON.stringify(m));
      }
      log('子特效灯：', st.models, '个外观，', st.lights, '盏（随曲线变', st.anim, '，噪声', st.noise, '，IES', st.ies, '）类型', JSON.stringify(st.types), '未支持的曲线类型', JSON.stringify(st.unhandled));
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
