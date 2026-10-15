// 从 CCP 官方 SDE（JSONL 版）生成官方中文名称表 eve-overview-clone/npc-names-zh.json
// 包含：NPC 空间站、NPC 军团、NPC 角色（代理人等）、星系、星座、星域。
// 玩家军团/联盟/角色名是玩家自定义的，不在此表中，前端保留原名。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_npc_names.mjs <解压目录> [--verify]
//      --verify 会用 ESI /universe/names/ 比对按同一规则生成的英文站名，确认拼接规则无误
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir, flag] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_npc_names.mjs <SDE JSONL 解压目录> [--verify]");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

async function loadMap(name) {
  const map = new Map();
  await eachLine(name, (o) => map.set(o._key, o));
  return map;
}

const pick = (names, lang) => names?.[lang] || names?.en || "";
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV",
  "XVI", "XVII", "XVIII", "XIX", "XX", "XXI", "XXII", "XXIII", "XXIV", "XXV"];
const MOON = { en: "Moon", zh: "卫星" };

const stations = await loadMap("npcStations");
const corporations = await loadMap("npcCorporations");
const operations = await loadMap("stationOperations");
const systems = await loadMap("mapSolarSystems");
const constellations = await loadMap("mapConstellations");
const regions = await loadMap("mapRegions");
const characters = await loadMap("npcCharacters");
// 卫星/行星只需要轨道关系和专有名（如 艾玛 VIII (欧瑞斯)），整表很大，逐行精简读取
const moons = new Map();
await eachLine("mapMoons", (o) => moons.set(o._key, { planet: o.orbitID, uniqueName: o.uniqueName }));
const planetNames = new Map();
await eachLine("mapPlanets", (o) => { if (o.uniqueName) planetNames.set(o._key, o.uniqueName); });

// 与游戏客户端一致的站名规则：轨道天体名 - 所属军团 [设施名]
function stationName(id, lang) {
  const s = stations.get(id);
  const system = pick(systems.get(s.solarSystemID)?.name, lang);
  const moon = moons.get(s.orbitID);
  let base;
  if (moon?.uniqueName) {
    base = pick(moon.uniqueName, lang);
  } else {
    const planet = moon ? moon.planet : s.orbitID;
    if (planetNames.has(planet)) base = pick(planetNames.get(planet), lang);
    else base = s.celestialIndex ? `${system} ${ROMAN[s.celestialIndex]}` : system;
    if (moon) base += ` - ${MOON[lang]} ${s.orbitIndex}`;
  }
  let name = `${base} - ${pick(corporations.get(s.ownerID)?.name, lang)}`;
  if (s.useOperationName) name += ` ${pick(operations.get(s.operationID)?.operationName, lang)}`;
  return name;
}

const toObject = (map, fn) => Object.fromEntries([...map.keys()].sort((a, b) => a - b).map((k) => [k, fn(k, map.get(k))]));

const output = {
  source: "CCP SDE (JSONL)",
  generatedAt: new Date().toISOString(),
  stations: toObject(stations, (id) => stationName(id, "zh")),
  corporations: toObject(corporations, (_, o) => pick(o.name, "zh")),
  characters: toObject(characters, (_, o) => pick(o.name, "zh")),
  systems: toObject(systems, (_, o) => pick(o.name, "zh")),
  constellations: toObject(constellations, (_, o) => pick(o.name, "zh")),
  regions: toObject(regions, (_, o) => pick(o.name, "zh"))
};

if (flag === "--verify") {
  const ids = [...stations.keys()];
  let mismatch = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const res = await fetch("https://esi.evetech.net/latest/universe/names/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ids.slice(i, i + 1000))
    });
    for (const { id, name } of await res.json()) {
      if (stationName(id, "en") !== name) {
        mismatch += 1;
        if (mismatch <= 20) console.log("不一致:", id, stationName(id, "en"), "≠", name);
      }
    }
  }
  console.log(`站名校验：${ids.length} 个空间站，${mismatch} 个与 ESI 不一致`);
  if (mismatch) process.exit(1);
}

await writeFile("eve-overview-clone/npc-names-zh.json", JSON.stringify(output));
console.log(Object.entries(output).filter(([, v]) => typeof v === "object").map(([k, v]) => `${k} ${Object.keys(v).length}`).join(" · "));
