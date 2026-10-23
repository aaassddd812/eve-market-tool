// 生成 NPC 出售蓝图数据 eve-overview-clone/npc-bp.json（制造页「NPC 蓝图」与计算器蓝图卡片用）
// 来源：CCP 官方 SDE（JSONL 版）——npcCorporations 的 corporationTrades（NPC 军团在自己空间站市场出售的物品）中属于蓝图的，
//       蓝图的 NPC 基础售价（types.basePrice），各军团所属势力（factionID）与拥有空间站的星域（npcStations → mapSolarSystems）。
// 输出：{ bp: { 蓝图ID: [NPC 价格, [军团ID…]] }, corps: { 军团ID: [名称, 势力ID, [星域ID…], 空间站数] }, factions: { 势力ID: 名称 } }
//
// 用法：node build_npc_bp.mjs <SDE JSONL 解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_npc_bp.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}
async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}
const zh = (n) => n?.zh || n?.en || "";

const blueprints = new Set();
await eachLine("blueprints", (o) => blueprints.add(o._key));
const price = new Map();
await eachLine("types", (o) => { if (blueprints.has(o._key) && o.published) price.set(o._key, o.basePrice || 0); });
const sysRegion = new Map();
await eachLine("mapSolarSystems", (o) => sysRegion.set(o._key, o.regionID));
const corpRegions = new Map(), corpStations = new Map();
await eachLine("npcStations", (o) => {
  const r = sysRegion.get(o.solarSystemID);
  if (!corpRegions.has(o.ownerID)) corpRegions.set(o.ownerID, new Set());
  if (r) corpRegions.get(o.ownerID).add(r);
  corpStations.set(o.ownerID, (corpStations.get(o.ownerID) || 0) + 1);
});
const bp = {}, corps = {}, factionIds = new Set();
await eachLine("npcCorporations", (o) => {
  let any = false;
  for (const t of o.corporationTrades || []) {
    if (!price.has(t._key)) continue;
    (bp[t._key] ||= [price.get(t._key), []])[1].push(o._key);
    any = true;
  }
  if (any) {
    corps[o._key] = [zh(o.name), o.factionID || 0, [...(corpRegions.get(o._key) || [])].sort((a, b) => a - b), corpStations.get(o._key) || 0];
    if (o.factionID) factionIds.add(o.factionID);
  }
});
const factions = {};
await eachLine("factions", (o) => { if (factionIds.has(o._key)) factions[o._key] = zh(o.name); });
await writeFile(new URL("./eve-overview-clone/npc-bp.json", import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), source: "CCP SDE", bp, corps, factions }));
console.log(`NPC 出售蓝图 ${Object.keys(bp).length} 种 · 军团 ${Object.keys(corps).length} 个 · 势力 ${Object.keys(factions).length} 个`);
