// 生成虫洞数据 eve-overview-clone/wh-data.json（虫洞页用）
// 来源：CCP 官方 SDE（JSONL 版）——虫洞星系、等级（星系 → 星座 → 星域上第一个有的 wormholeClassID）、天象（次级恒星类型）、
//       行星与卫星数量、全部虫洞类型及属性（通往等级、存活时间、总质量、单次质量、质量回复）；
//       各星系的固定出口（static）与虫洞出现在哪些等级不在 SDE 里，取自社区整理的 anoik.is 静态数据。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_wormholes.mjs <解压目录> [anoik static.json 路径或网址，默认 https://anoik.is/static/static.json]
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir, anoikSrc = "https://anoik.is/static/static.json"] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_wormholes.mjs <SDE JSONL 解压目录> [anoik static.json]");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const anoik = JSON.parse(anoikSrc.startsWith("http") ? await (await fetch(anoikSrc)).text() : await readFile(anoikSrc, "utf8"));

// 行星类型 → 单字母代码（与 pi-data.json 相同；碎裂行星记作 X）
const PLANET_CODES = { 11: "T", 12: "I", 13: "G", 2014: "O", 2015: "L", 2016: "B", 2017: "S", 2063: "P", 30889: "X" };
// 次级恒星类型 → 天象代码
const EFFECTS = { 30574: "magnetar", 30575: "blackhole", 30576: "redgiant", 30577: "pulsar", 30669: "wolfrayet", 30670: "cataclysmic" };
// anoik 的等级代码 → SDE wormholeClassID
const ANOIK_CLASS = Object.fromEntries(Object.entries(anoik.wormholeclasses).map(([k, v]) => [k, v.wormholeClassID]));

const whClass = new Map();   // 星座 / 星域 → 虫洞等级
const regionName = {};
await eachLine("mapRegions", (o) => {
  if (o.wormholeClassID) whClass.set(o._key, o.wormholeClassID);
  if (o._key >= 11000000 && o._key < 12000000) regionName[o._key] = o.name?.en || "";
});
await eachLine("mapConstellations", (o) => { if (o.wormholeClassID) whClass.set(o._key, o.wormholeClassID); });

const effectOf = new Map();
await eachLine("mapSecondarySuns", (o) => { if (EFFECTS[o.typeID]) effectOf.set(o.solarSystemID, EFFECTS[o.typeID]); });

const systems = [];
const sysById = new Map();
await eachLine("mapSolarSystems", (o) => {
  if (o.regionID < 11000000 || o.regionID >= 12000000) return;
  const cls = o.wormholeClassID || whClass.get(o.constellationID) || whClass.get(o.regionID) || 0;
  const s = { id: o._key, name: o.name?.zh || o.name?.en, cls, region: o.regionID, effect: effectOf.get(o._key) || null, planets: "", moons: 0, statics: [] };
  systems.push(s);
  sysById.set(o._key, s);
});
await eachLine("mapPlanets", (o) => {
  const s = sysById.get(o.solarSystemID);
  if (s) s.planets += PLANET_CODES[o.typeID] || "";
});
await eachLine("mapMoons", (o) => {
  const s = sysById.get(o.solarSystemID);
  if (s) s.moons++;
});
for (const a of Object.values(anoik.systems)) {
  const s = sysById.get(a.solarSystemID);
  if (s) s.statics = a.statics || [];
}

// 虫洞类型：SDE 虫洞分组（988）的属性；名称形如 Wormhole H296
const ATTR = { 1381: "dest", 1382: "life", 1383: "mass", 1384: "regen", 1385: "jump" };
const holes = new Map();
await eachLine("types", (o) => {
  if (o.groupID !== 988) return;
  const code = (o.name?.en || "").replace(/^Wormhole\s+/, "").trim();
  if (!/^[A-Z]\d{3}$/.test(code)) return;
  holes.set(o._key, { code, type: o._key });
});
await eachLine("typeDogma", (o) => {
  const h = holes.get(o._key);
  if (!h) return;
  for (const a of o.dogmaAttributes || []) if (ATTR[a.attributeID]) h[ATTR[a.attributeID]] = a.value;
});
const wormholes = [];
const seen = new Set();
for (const h of holes.values()) {
  if (seen.has(h.code)) continue;
  const a = anoik.wormholes[h.code];
  if (!a && !h.mass) continue;            // 未使用的类型
  seen.add(h.code);
  wormholes.push([
    h.code, h.type,
    h.code === "K162" ? 0 : a?.dest ? ANOIK_CLASS[a.dest] ?? h.dest ?? 0 : h.dest ?? 0,
    Math.round((h.life || 0) / 60),          // 分钟 → 小时
    h.mass || 0, h.jump || 0, h.regen || 0,
    (a?.src || []).map((c) => ANOIK_CLASS[c]).filter((x) => x != null),
    a?.static ? 1 : 0
  ]);
}
wormholes.sort((x, y) => x[0].localeCompare(y[0]));

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "CCP SDE + anoik.is",
  regions: regionName,
  // [星系ID, 名称, 等级, 星域ID, 天象, 行星代码串, 卫星数, [固定出口代码]]
  systems: systems.sort((a, b) => a.id - b.id).map((s) => [s.id, s.name, s.cls, s.region, s.effect, s.planets, s.moons, s.statics]),
  // [代码, typeID, 通往等级, 存活小时, 总质量 kg, 单次质量 kg, 质量回复 kg, [出现等级], 是否可作固定出口]
  wormholes
};
await writeFile(new URL("./eve-overview-clone/wh-data.json", import.meta.url), JSON.stringify(out));
console.log(`虫洞星系 ${systems.length}（有天象 ${systems.filter((s) => s.effect).length}，有固定出口 ${systems.filter((s) => s.statics.length).length}） · 虫洞类型 ${wormholes.length}`);
