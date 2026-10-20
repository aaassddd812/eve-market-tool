// 从 CCP 官方 SDE（JSONL 版）生成突变质体数据 eve-overview-clone/mutaplasmid-data.json
// dynamicItemAttributes：每种突变质体能改哪些属性、每项的倍率范围（相对原装备），以及能用在哪些原装备上、突变后得到哪种深渊装备。
// 模拟装配的「深渊装备自定义属性」用它限制每项属性的取值范围。
//
// 用法：node build_mutaplasmids.mjs <SDE JSONL 解压目录>（需含 dynamicItemAttributes.jsonl）
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_mutaplasmids.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}
async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const raw = [];
await eachLine("dynamicItemAttributes", (o) => raw.push(o));
const ids = new Set(raw.map((o) => o._key));
const names = new Map();
await eachLine("types", (o) => { if (ids.has(o._key)) names.set(o._key, [o.name?.zh || o.name?.en || "", o.name?.en || ""]); });
const attrIds = new Set(raw.flatMap((o) => o.attributeIDs.map((a) => a._key)));
const attrs = {};
await eachLine("dogmaAttributes", (o) => {
  if (attrIds.has(o._key)) attrs[o._key] = [o.displayName?.zh || o.displayName?.en || o.name, o.unitID || 0, o.name];
});
const units = {};
await eachLine("dogmaUnits", (o) => { units[o._key] = o.displayName?.zh || o.displayName?.en || ""; });

// [突变质体ID, 中文名, 英文名, [[属性ID, 最小倍率, 最大倍率, 数值越大越好 1 / 0 / -1 未指定]], [可用的原装备...], 突变后的深渊装备]
const muta = raw.filter((o) => o.inputOutputMapping?.length).map((o) => {
  const [zh, en] = names.get(o._key) || [String(o._key), ""];
  const io = o.inputOutputMapping[0];
  return [o._key, zh, en, o.attributeIDs.map((a) => [a._key, a.min, a.max, a.highIsGood === undefined ? -1 : a.highIsGood ? 1 : 0]), io.applicableTypes, io.resultingType];
});
await writeFile("eve-overview-clone/mutaplasmid-data.json", JSON.stringify({ source: "CCP SDE dynamicItemAttributes", generatedAt: new Date().toISOString(), muta, attrs, units }));
console.log(`突变质体 ${muta.length} · 属性 ${Object.keys(attrs).length}`);
