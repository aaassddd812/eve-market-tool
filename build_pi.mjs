// 从 CCP 官方 SDE（JSONL 版）生成行星工业数据 eve-overview-clone/pi-data.json
// 收录范围与星图一致（有 position2D 的星系）：每个星系的行星类型与半径、各类行星的设施与可采资源、全部配方。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_pi.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_pi.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const zh = (names) => names?.zh || names?.en || "";

// 行星类型 → 单字母代码（碎裂行星不能建殖民地，不收录）
const PLANET_CODES = { 11: "T", 12: "I", 13: "G", 2014: "O", 2015: "L", 2016: "B", 2017: "S", 2063: "P" };

// 设施分组 → 字段名
const PIN_GROUPS = { 1027: "cc", 1063: "ecu", 1029: "storage", 1030: "launchpad" };
const PROCESSOR_GROUP = 1028;
const EXTRACTOR_GROUP = 1026;
// 商品分组 → 等级（P0–P4）
const TIER_GROUPS = { 1032: 0, 1033: 0, 1035: 0, 1042: 1, 1034: 2, 1040: 3, 1041: 4 };

const ATTR = { powerLoad: 15, cpuLoad: 49, harvesterType: 709, planetRestriction: 1632 };

const types = new Map();
await eachLine("types", (o) => types.set(o._key, o));
const dogma = new Map();
await eachLine("typeDogma", (o) => {
  const t = types.get(o._key);
  if (t && (PIN_GROUPS[t.groupID] || t.groupID === PROCESSOR_GROUP || t.groupID === EXTRACTOR_GROUP)) {
    dogma.set(o._key, Object.fromEntries((o.dogmaAttributes || []).map((a) => [a.attributeID, a.value])));
  }
});

// 各类行星的设施类型与可采资源
const planetTypes = {};
for (const [id, code] of Object.entries(PLANET_CODES)) {
  planetTypes[id] = { code, name: zh(types.get(Number(id))?.name).replace(/^行星（(.+)）$/, "$1"), res: [] };
}
const structures = {};   // 设施类型 → [CPU, 电网]
for (const [id, t] of types) {
  const attrs = dogma.get(id);
  if (!attrs) continue;
  const planet = planetTypes[attrs[ATTR.planetRestriction]];
  if (!planet || t.published === false) continue;
  if (t.groupID === EXTRACTOR_GROUP) {
    planet.res.push(attrs[ATTR.harvesterType]);
    continue;
  }
  structures[id] = [attrs[ATTR.cpuLoad] || 0, attrs[ATTR.powerLoad] || 0];
  if (PIN_GROUPS[t.groupID]) planet[PIN_GROUPS[t.groupID]] = id;
  else if (/High-Tech/.test(t.name.en)) planet.ht = id;
  else if (/Advanced/.test(t.name.en)) planet.adv = id;
  else planet.basic = id;
}
for (const p of Object.values(planetTypes)) p.res.sort((a, b) => a - b);

// 商品：[中文名, 英文名, 等级, 体积]
const commodities = {};
for (const [id, t] of types) {
  const tier = TIER_GROUPS[t.groupID];
  if (tier !== undefined && t.published) commodities[id] = [zh(t.name), t.name.en, tier, t.volume || 0];
}

// 配方：[配方ID, 周期(秒), 产物, 产量, [[原料, 数量], ...]]
const schematics = [];
await eachLine("planetSchematics", (o) => {
  const out = o.types.find((x) => !x.isInput);
  if (!out || !commodities[out._key]) return;
  schematics.push([o._key, o.cycleTime, out._key, out.quantity,
    o.types.filter((x) => x.isInput).map((x) => [x._key, x.quantity])]);
});
schematics.sort((a, b) => a[0] - b[0]);

// 星系 → 行星：[星系ID, 类型代码串, [半径(km)], [天体序号]]
const included = new Set();
await eachLine("mapSolarSystems", (o) => { if (o.position2D) included.add(o._key); });
const bySystem = new Map();
await eachLine("mapPlanets", (o) => {
  const code = PLANET_CODES[o.typeID];
  if (!code || !included.has(o.solarSystemID)) return;
  if (!bySystem.has(o.solarSystemID)) bySystem.set(o.solarSystemID, []);
  bySystem.get(o.solarSystemID).push([o.celestialIndex, code, Math.round(o.radius / 1000)]);
});
const systems = [...bySystem.entries()].sort((a, b) => a[0] - b[0]).map(([id, list]) => {
  list.sort((a, b) => a[0] - b[0]);
  return [id, list.map((p) => p[1]).join(""), list.map((p) => p[2]), list.map((p) => p[0])];
});

const output = {
  source: "CCP SDE (JSONL)",
  generatedAt: new Date().toISOString(),
  planetTypes,
  structures,
  commodities,
  schematics,
  systems
};
await writeFile("eve-overview-clone/pi-data.json", JSON.stringify(output));
console.log(`行星类型 ${Object.keys(planetTypes).length} · 设施 ${Object.keys(structures).length} · 商品 ${Object.keys(commodities).length} · 配方 ${schematics.length} · 星系 ${systems.length} · 行星 ${systems.reduce((n, s) => n + s[1].length, 0)}`);
