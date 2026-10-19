// 从 CCP 官方 SDE（JSONL 版）生成 NPC 人物位置表 eve-overview-clone/npc-data.json
// ESI 查不到 NPC 的位置（/characters/{id}/location/ 需要该角色本人授权），代理人的驻地只在 SDE 里：
//   npcCharacters.locationID 是驻扎的 NPC 空间站；agentsInSpace 是在太空据点里的代理人（只有星系）。
// 星图搜索 NPC 人物、星系面板列出本星系代理人都用这份数据。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_npc.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_npc.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const stationSystem = new Map();
await eachLine("npcStations", (o) => stationSystem.set(o._key, o.solarSystemID));
const inSpace = new Map();
await eachLine("agentsInSpace", (o) => inSpace.set(o._key, o.solarSystemID));
const divisions = {};
await eachLine("npcCorporationDivisions", (o) => { divisions[o._key] = o.name?.zh || o.name?.en || o.displayName || ""; });

const npcs = [];
await eachLine("npcCharacters", (o) => {
  const space = inSpace.get(o._key) || 0;
  const station = space ? 0 : o.locationID && stationSystem.has(o.locationID) ? o.locationID : 0;
  const system = space || stationSystem.get(station) || 0;
  if (!system) return;   // 没有位置的 NPC（剧情人物等）不收录
  const zh = o.name?.zh || o.name?.en || "";
  const en = o.name?.en && o.name.en !== zh ? o.name.en : "";
  const a = o.agent;
  npcs.push([o._key, zh, en, o.corporationID || 0, station, system,
    a?.agentTypeID || 0, a?.divisionID || 0, a?.level || 0, a?.isLocator ? 1 : 0, o.ceo ? 1 : 0]);
});
npcs.sort((x, y) => x[0] - y[0]);

const output = {
  source: "CCP SDE",
  generatedAt: new Date().toISOString(),
  divisions,
  // [id, 中文名, 英文名（与中文相同时为空）, 军团ID, 空间站ID（太空代理人为 0）, 星系ID, 代理人类型, 部门ID, 等级, 可定位, 军团 CEO]
  npcs
};
await writeFile("eve-overview-clone/npc-data.json", JSON.stringify(output));
console.log(`NPC ${npcs.length} · 代理人 ${npcs.filter((n) => n[6]).length} · 太空代理人 ${npcs.filter((n) => !n[4]).length}`);
