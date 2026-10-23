// 从 CCP 官方 SDE（JSONL 版）生成物品英文名映射 eve-overview-clone/type-names-en.json
// 用途：前端中英对照显示（中文名旁附英文名小字）+ 目录搜索支持英文。
// 只收 published=true 的物品（约 2.7 万条，输出约 1MB）。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_type_names_en.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_type_names_en.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

const out = {};
const rl = createInterface({ input: createReadStream(`${sdeDir}/types.jsonl`, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  if (t.published === false) continue;
  const en = t.name?.en;
  if (en) out[String(t._key)] = en;
}

await writeFile(new URL("./eve-overview-clone/type-names-en.json", import.meta.url),
  JSON.stringify(out), "utf8");
console.log(`生成 ${Object.keys(out).length} 条英文名映射`);
