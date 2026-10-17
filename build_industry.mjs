// 从 CCP 官方 SDE（JSONL 版）生成制造数据 eve-overview-clone/industry-data.json 与技能数据 eve-overview-clone/skill-data.json
//
// industry-data.json：
//   bp      产品 -> [蓝图ID, 每流程产量, 基础时间(秒), [[材料, 数量], ...], 最大流程数, 活动(m 制造 / r 反应), [[技能, 等级], ...], 蓝图在市场出售(1/0)]
//   inv     T2 蓝图 -> [T1 蓝图, 基础成功率, 每份流程数, [[数据核心, 数量], ...], 时间(秒), [技能...]]
//   types   物品 -> [中文名, 英文名, 分组, 科技等级, 元组, 体积]（只收录用到的物品）
//   groups  分组 -> [中文名, 大类]；cats 大类 -> 中文名；metas 元组 -> 中文名
//   decryptors 解码器 -> [成功率倍数, 材料效率, 时间效率, 流程数]
//   structures 工业建筑类型 -> 中文名
// skill-data.json：
//   skills  技能 -> [中文名, 英文名, 分组, 等级倍数(rank), 主属性, 副属性, 说明]
//   groups  技能分组 -> 中文名
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_industry.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_industry.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}
const zh = (names) => names?.zh || names?.en || "";

const types = new Map();
await eachLine("types", (o) => types.set(o._key, o));
const groups = new Map();
await eachLine("groups", (o) => groups.set(o._key, o));
const cats = new Map();
await eachLine("categories", (o) => cats.set(o._key, o));
const metas = {};
await eachLine("metaGroups", (o) => { metas[o._key] = zh(o.name); });

const DECRYPTOR_GROUP = 1304;
const SKILL_CATEGORY = 16;
const ATTR = { rank: 275, primary: 180, secondary: 181, decProb: 1112, decME: 1113, decTE: 1114, decRuns: 1124 };
const dogma = new Map();
await eachLine("typeDogma", (o) => {
  const t = types.get(o._key);
  if (!t) return;
  const g = groups.get(t.groupID);
  if (t.groupID === DECRYPTOR_GROUP || g?.categoryID === SKILL_CATEGORY) {
    dogma.set(o._key, Object.fromEntries((o.dogmaAttributes || []).map((a) => [a.attributeID, a.value])));
  }
});

const used = new Set();
const pairs = (list) => (list || []).map((m) => [m.typeID, m.quantity]);
const skillPairs = (list) => (list || []).map((s) => [s.typeID, s.level]);

// 蓝图：只收录产品可在市场交易的制造 / 反应
const bp = {};
const bpByProduct = new Map();
const inventionRaw = [];
await eachLine("blueprints", (o) => {
  const bpType = types.get(o.blueprintTypeID);
  if (!bpType || bpType.published === false) return;
  for (const [act, code] of [["manufacturing", "m"], ["reaction", "r"]]) {
    const a = o.activities[act];
    const prod = a?.products?.[0];
    if (!prod || !a.materials?.length) continue;
    const pt = types.get(prod.typeID);
    if (!pt || !pt.published || !pt.marketGroupID) continue;
    if (bp[prod.typeID] && code === "m" && bp[prod.typeID][5] === "m") continue;   // 少数产品有多张蓝图，保留第一张
    // 最后一项：蓝图能否在 NPC 市场买到（1 / 0）；买不到的 T1 蓝图多来自 LP 商店或掉落
    bp[prod.typeID] = [o.blueprintTypeID, prod.quantity, a.time, pairs(a.materials), o.maxProductionLimit || 1, code, skillPairs(a.skills), bpType.marketGroupID ? 1 : 0];
    bpByProduct.set(o.blueprintTypeID, prod.typeID);
    used.add(prod.typeID); used.add(o.blueprintTypeID);
    a.materials.forEach((m) => used.add(m.typeID));
    (a.skills || []).forEach((s) => used.add(s.typeID));
  }
  if (o.activities.invention?.products?.length) inventionRaw.push(o);
});

// 发明：T1 蓝图 -> T2 蓝图
const inv = {};
for (const o of inventionRaw) {
  const a = o.activities.invention;
  for (const p of a.products) {
    if (!bpByProduct.has(p.typeID)) continue;
    inv[p.typeID] = [o.blueprintTypeID, p.probability || 0, p.quantity || 1, pairs(a.materials), a.time, skillPairs(a.skills)];
    used.add(o.blueprintTypeID);
    a.materials.forEach((m) => used.add(m.typeID));
    a.skills.forEach((s) => used.add(s.typeID));
  }
}

// 解码器
const decryptors = {};
for (const [id, t] of types) {
  if (t.groupID !== DECRYPTOR_GROUP || !t.published) continue;
  const d = dogma.get(id) || {};
  decryptors[id] = [d[ATTR.decProb] || 1, d[ATTR.decME] || 0, d[ATTR.decTE] || 0, d[ATTR.decRuns] || 0];
  used.add(id);
}

// 工业建筑（工程复合体 / 精炼厂）
const STRUCTURES = [35825, 35826, 35827, 35835, 35836];
const structures = Object.fromEntries(STRUCTURES.map((id) => [id, zh(types.get(id)?.name)]));
// 计算里用到的技能
[3380, 3388, 45746, 16622, 3446].forEach((id) => used.add(id));

const outTypes = {};
const usedGroups = new Set();
for (const id of used) {
  const t = types.get(id);
  if (!t) continue;
  outTypes[id] = [zh(t.name), t.name?.en || "", t.groupID, t.techLevel || 1, t.metaGroupID || 0, t.packagedVolume || t.volume || 0];
  usedGroups.add(t.groupID);
}
const outGroups = {};
const usedCats = new Set();
for (const id of usedGroups) {
  const g = groups.get(id);
  if (!g) continue;
  outGroups[id] = [zh(g.name), g.categoryID];
  usedCats.add(g.categoryID);
}
const outCats = Object.fromEntries([...usedCats].map((id) => [id, zh(cats.get(id)?.name)]));

await writeFile("eve-overview-clone/industry-data.json", JSON.stringify({
  source: "CCP SDE (JSONL)", generatedAt: new Date().toISOString(),
  bp, inv, types: outTypes, groups: outGroups, cats: outCats, metas, decryptors, structures
}));

// 技能
const skills = {};
const skillGroups = {};
for (const [id, t] of types) {
  const g = groups.get(t.groupID);
  if (g?.categoryID !== SKILL_CATEGORY || !t.published || !g.published) continue;
  const d = dogma.get(id) || {};
  skills[id] = [zh(t.name), t.name?.en || "", t.groupID, d[ATTR.rank] || 1, d[ATTR.primary] || 0, d[ATTR.secondary] || 0, zh(t.description)];
  skillGroups[t.groupID] = zh(g.name);
}
await writeFile("eve-overview-clone/skill-data.json", JSON.stringify({
  source: "CCP SDE (JSONL)", generatedAt: new Date().toISOString(), skills, groups: skillGroups
}));

console.log(`蓝图 ${Object.keys(bp).length} · 发明 ${Object.keys(inv).length} · 物品 ${Object.keys(outTypes).length} · 解码器 ${Object.keys(decryptors).length} · 技能 ${Object.keys(skills).length}（${Object.keys(skillGroups).length} 组）`);
