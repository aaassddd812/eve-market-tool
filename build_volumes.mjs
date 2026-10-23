// 生成物品体积表 eve-overview-clone/type-volume.json（倒卖运费、每立方利润用）
// 来源：CCP 官方 SDE（JSONL 版）types —— 市场上能交易的物品（published 且有 marketGroupID），取包装体积（packagedVolume，舰船等可打包物品），没有时取体积。
// 输出：{ typeID: 立方米 }，最多保留 4 位小数
//
// 用法：node build_volumes.mjs <SDE JSONL 解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_volumes.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}
const out = {};
const rl = createInterface({ input: createReadStream(`${sdeDir}/types.jsonl`, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  if (!t.published || !t.marketGroupID) continue;
  const v = t.packagedVolume ?? t.volume;
  if (v == null) continue;
  out[t._key] = Math.round(v * 1e4) / 1e4;
}
await writeFile(new URL("./eve-overview-clone/type-volume.json", import.meta.url), JSON.stringify(out));
console.log(`物品 ${Object.keys(out).length} 个`);
