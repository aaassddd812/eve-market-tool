// 从 CCP 官方 SDE（JSONL 版）生成化矿（再处理）数据 eve-overview-clone/reprocess-data.json
//
//   t       物品 -> [每批数量(portionSize), 化矿技能(矿石 / 冰矿的专属处理技能，其它物品为 0 = 碎铁处理), [产物, 数量, 产物, 数量, ...]]
//           （只收录可在市场交易的物品；数量为 100% 产出时一批得到的数量）
//   skills  用到的化矿技能 -> 中文名
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_reprocess.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_reprocess.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}
const zh = (names) => names?.zh || names?.en || "";

const types = new Map();
await eachLine("types", (o) => types.set(o._key, o));

const ATTR_SKILL = 790;   // reprocessingSkillType
const skillOf = new Map();
await eachLine("typeDogma", (o) => {
  const a = (o.dogmaAttributes || []).find((x) => x.attributeID === ATTR_SKILL);
  if (a) skillOf.set(o._key, Math.round(a.value));
});

const t = {};
const skills = {};
for (const id of [3385, 3389, 12196]) skills[id] = zh(types.get(id)?.name);   // 提炼学概论、提炼效率理论、碎铁处理技术
await eachLine("typeMaterials", (o) => {
  const type = types.get(o._key);
  if (!type || !type.published || !type.marketGroupID || !o.materials?.length) return;
  const skill = skillOf.get(o._key) || 0;
  if (skill && !skills[skill]) skills[skill] = zh(types.get(skill)?.name);
  t[o._key] = [type.portionSize || 1, skill, o.materials.flatMap((m) => [m.materialTypeID, m.quantity])];
});

const out = { source: "CCP SDE typeMaterials", generatedAt: new Date().toISOString(), skills, t };
await writeFile(new URL("./eve-overview-clone/reprocess-data.json", import.meta.url), JSON.stringify(out));
console.log(`物品 ${Object.keys(t).length}，技能 ${Object.keys(skills).length}`);
