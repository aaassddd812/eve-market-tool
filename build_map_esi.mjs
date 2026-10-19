// 从 ESI 抓取曙光服（datasource=infinity）星图，生成 eve-overview-clone/map-data-infinity.json
// 曙光服星图与宁静 / 晨曦不同：星系 ID 相同，但坐标、星门连接、星座 / 星域归属都重新排布过，还有曙光独有的星域。
// SDE 只有宁静数据，所以布局（坐标、安全等级、星门、星座、星域、空间站）全部取自曙光 ESI；
// ESI 没有的字段（恒星类型、阵营、星域描述）按 ID 从 SDE 补。输出格式与 build_map.mjs 的 map-data.json 完全一致。
//
// 用法：node build_map_esi.mjs <SDE JSONL 解压目录> [缓存目录]
//   约 2 万次 ESI 请求，响应缓存在缓存目录（默认 ./.esi-cache-infinity），中断后重跑会跳过已抓取的部分。
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir, cacheDir = ".esi-cache-infinity"] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_map_esi.mjs <SDE JSONL 解压目录> [缓存目录]");
  process.exit(1);
}
const ESI = "https://ali-esi.evepc.163.com/latest";
const DATASOURCE = "infinity";
mkdirSync(cacheDir, { recursive: true });

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}
const zh = (names) => names?.zh || names?.en || "";
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esi(path) {
  const file = `${cacheDir}/${path.replace(/[/?&=]+/g, "_")}.json`;
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${ESI}${path}${path.includes("?") ? "&" : "?"}datasource=${DATASOURCE}&language=zh`);
      if (res.ok) {
        const data = await res.json();
        await writeFile(file, JSON.stringify(data));
        return data;
      }
      // 错误额度快用完时等它重置
      const remain = Number(res.headers.get("x-esi-error-limit-remain"));
      if (remain < 20) await sleep((Number(res.headers.get("x-esi-error-limit-reset")) || 30) * 1000);
      if (res.status === 404 || attempt >= 5) throw new Error(`${path} ${res.status}`);
    } catch (e) {
      if (attempt >= 5 || /404/.test(e.message)) throw e;
    }
    await sleep(1000 * attempt);
  }
}

// 并发抓取，显示进度
async function pool(items, fn, label, size = 24) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      if (++done % 500 === 0 || done === items.length) console.log(`${label} ${done}/${items.length}`);
    }
  }));
  return out;
}

// 1. 星系：跳过虫洞（31xxxxxx）与深渊（32xxxxxx），再只保留有星门的星系
const allIds = await esi("/universe/systems/");
const candidates = allIds.filter((id) => !(id >= 31000000 && id < 33000000)).sort((a, b) => a - b);
const fetched = await pool(candidates, (id) => esi(`/universe/systems/${id}/`), "星系");
const systems = fetched.filter((s) => s.stargates?.length);
const index = new Map(systems.map((s, i) => [s.system_id, i]));

// 2. 星门
const gateIds = systems.flatMap((s) => s.stargates);
const gateInfo = await pool(gateIds, (id) => esi(`/universe/stargates/${id}/`), "星门");
const gateSet = new Set();
const gates = [];
for (const g of gateInfo) {
  const a = index.get(g.system_id), b = index.get(g.destination?.system_id);
  if (a === undefined || b === undefined) continue;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (gateSet.has(key)) continue;
  gateSet.add(key);
  gates.push(a < b ? [a, b] : [b, a]);
}

// 3. 星座 / 星域
const constIds = await esi("/universe/constellations/");
const constInfo = await pool(constIds, (id) => esi(`/universe/constellations/${id}/`), "星座");
const constById = new Map(constInfo.map((c) => [c.constellation_id, c]));
const regionIds = await esi("/universe/regions/");
const regionInfo = await pool(regionIds, (id) => esi(`/universe/regions/${id}/`), "星域");
const regionById = new Map(regionInfo.map((r) => [r.region_id, r]));

// 4. SDE 补充：恒星类型、星系 / 星域阵营、星域描述（ESI 星域描述是英文或缺失时用 SDE）
const starType = new Map();
await eachLine("mapStars", (o) => starType.set(o._key, o.typeID));
const sdeSystem = new Map();
await eachLine("mapSolarSystems", (o) => sdeSystem.set(o._key, o));
const sdeRegion = new Map();
await eachLine("mapRegions", (o) => sdeRegion.set(o._key, o));
const factions = {};
await eachLine("factions", (o) => {
  factions[o._key] = { name: zh(o.name), corp: o.corporationID || 0, description: zh(o.description) };
});

const regionOf = (s) => constById.get(s.constellation_id)?.region_id || 0;
const usedRegions = new Set(systems.map(regionOf));
const usedConstellations = new Set(systems.map((s) => s.constellation_id));
const regions = [...usedRegions].sort((a, b) => a - b).map((id) => {
  const r = regionById.get(id), sde = sdeRegion.get(id);
  return [id, r?.name || zh(sde?.name), sde?.factionID || 0, sde ? zh(sde.description) : r?.description || ""];
});
const constellations = [...usedConstellations].sort((a, b) => a - b)
  .map((id) => [id, constById.get(id)?.name || "", constById.get(id)?.region_id || 0]);

const output = {
  source: `ESI ${DATASOURCE} + CCP SDE`,
  generatedAt: new Date().toISOString(),
  // [id, 中文名, x, y, z, 安全等级, 星域ID, 星座ID, 阵营ID, 恒星类型ID, 行星数, [NPC空间站ID]]
  systems: systems.map((s) => [
    s.system_id, s.name,
    round(s.position.x / 1e15, 2), round(s.position.y / 1e15, 2), round(-s.position.z / 1e15, 2),
    round(s.security_status, 3), regionOf(s), s.constellation_id, sdeSystem.get(s.system_id)?.factionID || 0,
    starType.get(s.star_id) || 0, (s.planets || []).length,
    (s.stations || []).filter((id) => id < 61000000)   // 只要 NPC 空间站
  ]),
  gates,
  regions,
  constellations,
  factions
};
await writeFile("eve-overview-clone/map-data-infinity.json", JSON.stringify(output));

console.log(`星系 ${output.systems.length} · 星门连接 ${gates.length} · 星域 ${regions.length} · 星座 ${constellations.length}`);
