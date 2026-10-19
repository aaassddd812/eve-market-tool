// 从 CCP 官方 SDE（JSONL 版）生成属性中文名表 eve-overview-clone/dogma-attr-zh.json
// ESI /dogma/attributes/{id}/ 只有英文名；突变装备（/dogma/dynamic/items/）的属性对比用这份表显示中文名与单位。
//
// 用法：node build_dogma_names.mjs <SDE JSONL 解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_dogma_names.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}
async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const units = {};
await eachLine("dogmaUnits", (o) => { units[o._key] = o.displayName?.zh || o.displayName?.en || ""; });
const attrs = {};
await eachLine("dogmaAttributes", (o) => {
  const name = o.displayName?.zh || o.displayName?.en;
  if (!o.published || !name) return;
  // [中文名, 单位 ID, 数值越大越好]
  attrs[o._key] = [name, o.unitID || 0, o.highIsGood ? 1 : 0];
});
await writeFile("eve-overview-clone/dogma-attr-zh.json", JSON.stringify({ attrs, units }));
console.log(`属性 ${Object.keys(attrs).length} · 单位 ${Object.keys(units).length}`);
