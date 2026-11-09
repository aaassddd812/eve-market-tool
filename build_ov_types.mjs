// 从 CCP 官方 SDE（JSONL 版）生成总览预警（ov-watch.js）用的名称表 eve-overview-clone/ov-types.json
// 总览「类型」一列显示的是物品类型名：NPC（实体分类 11）与玩家舰船（分类 6）。文字识别出来的名字按这张表模糊匹配，得到级别：
//   NPC 按所属分组名判断（「小行星血袭者泰坦」→ 泰坦、「死亡空间血袭者战列舰」→ 战列舰），分组名看不出级别的（流浪者实体、三神裔实体等）
//   按信号半径粗分（只给巡洋舰及以下 / 战列舰 / 旗舰三档）；分组名带 Officer 的加「官员」标签，带 Commander 的加「指挥官」标签。
//   玩家舰船按舰船分组归到同样的级别（掠夺舰、黑隐特勤舰算战列舰，指挥舰、攻击战巡算战巡……）。
// 输出：{ v, t: [[中文名, 英文名, 级别, 标签, 是否 NPC(1/0)], …] }，同名只留一条。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_ov_types.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_ov_types.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

// NPC 分组名（英文）里的级别关键词，先匹配的优先（Supercarrier 在 Carrier 前，Battlecruiser 在 Battleship、Cruiser 前）
const NPC_CLASS = [
  [/titan/i, "titan"], [/super ?carrier/i, "super"], [/force auxiliary/i, "fax"], [/carrier/i, "carrier"], [/dreadnought/i, "dread"],
  [/capital/i, "capital"], [/battle ?cruiser/i, "bc"], [/battleship/i, "bs"], [/cruiser/i, "cruiser"], [/destroyer/i, "destroyer"],
  [/frigate|corvette/i, "frigate"], [/hauler|industrial|transport|freighter|mining/i, "industrial"],
  [/sentry|structure|tower|billboard|container|cache|point|hub|cloud|belongings/i, "structure"], [/drone|swarm|fighter/i, "drone"]
];
// 玩家舰船分组 ID → 级别
const SHIP_CLASS = {
  titan: [30], super: [659], carrier: [547, 5120], fax: [1538], dread: [485, 4594],
  bs: [27, 898, 900, 381], bc: [419, 1201, 540], cruiser: [26, 358, 832, 833, 894, 906, 963, 1972],
  destroyer: [420, 541, 1305, 1534], frigate: [25, 237, 324, 830, 831, 834, 893, 1283, 1527, 1022],
  industrial: [28, 380, 463, 513, 543, 883, 902, 941, 1202, 4902], other: [29, 31, 2001, 5087]
};
const shipClassOf = Object.fromEntries(Object.entries(SHIP_CLASS).flatMap(([c, ids]) => ids.map((id) => [id, c])));

const groups = new Map();
await eachLine("groups", (o) => groups.set(o._key, o));
const sig = new Map();   // 信号半径（属性 552）
await eachLine("typeDogma", (o) => {
  const a = o.dogmaAttributes?.find((x) => x.attributeID === 552);
  if (a) sig.set(o._key, a.value);
});
const bySig = (r) => (r == null ? "other" : r >= 2000 ? "capital" : r >= 250 ? "bs" : "cruiser");

const out = new Map();
await eachLine("types", (t) => {
  const g = groups.get(t.groupID);
  if (!g || (g.categoryID !== 6 && g.categoryID !== 11)) return;
  const zh = (t.name?.zh || "").trim(), en = (t.name?.en || "").trim();
  if (!zh && !en) return;
  let cls, tags = "", npc = g.categoryID === 11 ? 1 : 0;
  if (npc) {
    const gn = g.name?.en || "";
    cls = NPC_CLASS.find(([re]) => re.test(gn))?.[1] || bySig(sig.get(t._key));
    if (/officer/i.test(gn)) tags += "o";
    if (/commander/i.test(gn)) tags += "c";
  } else {
    if (!t.published) return;
    cls = shipClassOf[t.groupID] || "other";
  }
  const key = (zh || en) + "|" + npc;
  if (!out.has(key)) out.set(key, [zh, en, cls, tags, npc]);
});

const t = [...out.values()];
await writeFile(new URL("./eve-overview-clone/ov-types.json", import.meta.url), JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), t }));
const count = {};
for (const r of t) count[r[2]] = (count[r[2]] || 0) + 1;
console.log(`ov-types.json：${t.length} 条`, count);
