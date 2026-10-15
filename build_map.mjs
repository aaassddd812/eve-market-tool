// 从 CCP 官方 SDE（JSONL 版）生成星图数据 eve-overview-clone/map-data.json
// 坐标使用 SDE 的三维 position（旧版 3D 星图），收录有星门连接的常规空间与波赫文（即带 position2D 的星系）；虫洞空间不收录。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_map.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_map.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const zh = (names) => names?.zh || names?.en || "";
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// 星系
const systems = [];
await eachLine("mapSolarSystems", (o) => { if (o.position2D) systems.push(o); });
systems.sort((a, b) => a._key - b._key);
const index = new Map(systems.map((s, i) => [s._key, i]));

// 恒星类型（用于恒星图标）
const starType = new Map();
await eachLine("mapStars", (o) => starType.set(o._key, o.typeID));

// NPC 空间站按星系归组
const stationsBySystem = new Map();
await eachLine("npcStations", (o) => {
  if (!index.has(o.solarSystemID)) return;
  if (!stationsBySystem.has(o.solarSystemID)) stationsBySystem.set(o.solarSystemID, []);
  stationsBySystem.get(o.solarSystemID).push(o._key);
});

// 星门连接（无向，去重）
const gateSet = new Set();
const gates = [];
await eachLine("mapStargates", (o) => {
  const a = index.get(o.solarSystemID);
  const b = index.get(o.destination?.solarSystemID);
  if (a === undefined || b === undefined) return;
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  if (gateSet.has(key)) return;
  gateSet.add(key);
  gates.push(a < b ? [a, b] : [b, a]);
});

// 星域 / 星座 / 阵营
const usedRegions = new Set(systems.map((s) => s.regionID));
const usedConstellations = new Set(systems.map((s) => s.constellationID));
const regions = [];
await eachLine("mapRegions", (o) => {
  if (usedRegions.has(o._key)) regions.push([o._key, zh(o.name), o.factionID || 0, zh(o.description)]);
});
const constellations = [];
await eachLine("mapConstellations", (o) => {
  if (usedConstellations.has(o._key)) constellations.push([o._key, zh(o.name), o.regionID]);
});
const factions = {};
await eachLine("factions", (o) => {
  factions[o._key] = { name: zh(o.name), corp: o.corporationID || 0, description: zh(o.description) };
});

// 坐标缩放到 1e15 米、保留 2 位小数，并转换为 three.js 坐标 (x, y, -z)：EVE 的 +z 为北，俯视时北方朝上
const output = {
  source: "CCP SDE (JSONL)",
  generatedAt: new Date().toISOString(),
  // [id, 中文名, x, y, z, 安全等级, 星域ID, 星座ID, 阵营ID, 恒星类型ID, 行星数, [NPC空间站ID]]
  systems: systems.map((s) => [
    s._key, zh(s.name),
    round(s.position.x / 1e15, 2), round(s.position.y / 1e15, 2), round(-s.position.z / 1e15, 2),
    round(s.securityStatus, 3), s.regionID, s.constellationID, s.factionID || 0,
    starType.get(s.starID) || 0, (s.planetIDs || []).length,
    stationsBySystem.get(s._key) || []
  ]),
  gates,
  regions: regions.sort((a, b) => a[0] - b[0]),
  constellations: constellations.sort((a, b) => a[0] - b[0]),
  factions
};

await writeFile("eve-overview-clone/map-data.json", JSON.stringify(output));
console.log(`星系 ${output.systems.length} · 星门连接 ${gates.length} · 星域 ${regions.length} · 星座 ${constellations.length} · 阵营 ${Object.keys(factions).length}`);
