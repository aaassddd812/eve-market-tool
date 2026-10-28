// 从 CCP 官方 SDE（JSONL 版）生成工业建筑与改装件加成 eve-overview-clone/ind-rigs.json（制造页「我的建筑」用）
//
// ind-rigs.json：
//   hulls   建筑类型 -> { n 中文名, en 英文名, g 分组, size 改装件尺寸, b: { 活动: [ME%, TE%, 安装费%] } }
//           只收录能做工业的建筑（工程复合体、精炼厂、星城）；b 里是船体自带的减免（正数 = 减少多少 %）
//   rigs    改装件 -> { n, en, size, fit: [可装的建筑分组], sec: [高安, 低安, 00/虫洞 倍数], m: [[活动, 种类, 数值%, 过滤器]] }
//           种类 me / te / cost；数值是未乘安全等级倍数的减免 %；过滤器 0 = 不限产品
//   filters 过滤器 -> { n 名称, c: [大类], g: [分组] }（产品属于其中任一大类或分组即生效）
// 活动：m 制造、r 反应、i 发明、c 拷贝、me 材料研究、te 时间研究
//
// 数据来源：industryModifierSources（谁对哪个活动的哪种数值生效、按哪个过滤器）、industryTargetFilters、
//   typeDogma（数值），dogmaEffects（改装件属性 → 建筑属性的对应关系）
//
// 用法：node build_ind_rigs.mjs <SDE JSONL 解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_ind_rigs.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const ACT = { manufacturing: "m", reaction: "r", invention: "i", copying: "c", researchMaterial: "me", researchTime: "te" };
const KIND = { material: "me", time: "te", cost: "cost" };
const HULL_GROUPS = new Set([1404, 1406, 1657]);   // 工程复合体、精炼厂、星城
const RIG_SIZE = 1547;
const FIT_GROUP_ATTRS = [1298, 1299, 1300, 1301, 1872, 1879, 1880, 1881];
const SEC_ATTRS = [2355, 2356, 2357];

const sources = new Map();
await eachLine("industryModifierSources", (o) => sources.set(o._key, o));
const filters = {};
await eachLine("industryTargetFilters", (o) => { filters[o._key] = { n: o.name, c: o.categoryIDs || [], g: o.groupIDs || [] }; });

const types = new Map();
await eachLine("types", (o) => { if (sources.has(o._key) || HULL_GROUPS.has(o.groupID)) types.set(o._key, o); });
const dogma = new Map();
const effectsOf = new Map();
await eachLine("typeDogma", (o) => {
  if (!types.has(o._key)) return;
  dogma.set(o._key, Object.fromEntries((o.dogmaAttributes || []).map((a) => [a.attributeID, a.value])));
  effectsOf.set(o._key, (o.dogmaEffects || []).map((e) => e.effectID));
});
const effects = new Map();
await eachLine("dogmaEffects", (o) => effects.set(o._key, o));

const round = (v) => Math.round(v * 10000) / 10000;
const hulls = {};
const rigs = {};
for (const [id, t] of types) {
  if (t.published === false) continue;
  const attrs = dogma.get(id) || {};
  const src = sources.get(id);
  const name = { n: t.name?.zh || t.name?.en || "", en: t.name?.en || "" };
  if (HULL_GROUPS.has(t.groupID)) {
    const b = {};
    for (const [act, kinds] of Object.entries(src || {})) {
      if (!ACT[act]) continue;
      const row = [0, 0, 0];
      for (const [kind, list] of Object.entries(kinds)) {
        const i = { material: 0, time: 1, cost: 2 }[kind];
        for (const m of list) if (attrs[m.dogmaAttributeID] != null && !m.filterID) row[i] = round((1 - attrs[m.dogmaAttributeID]) * 100);
      }
      if (row.some(Boolean)) b[ACT[act]] = row;
    }
    hulls[id] = { ...name, g: t.groupID, size: attrs[RIG_SIZE] || 0, b };
    continue;
  }
  if (!src) continue;
  // 改装件：建筑属性（industryModifierSources 里的 dogmaAttributeID）由改装件的哪个属性修改
  const byStructAttr = new Map();
  for (const eid of effectsOf.get(id) || []) {
    for (const mi of effects.get(eid)?.modifierInfo || []) {
      if (mi.domain === "structureID" && mi.modifyingAttributeID) byStructAttr.set(mi.modifiedAttributeID, mi.modifyingAttributeID);
    }
  }
  const mods = [];
  for (const [act, kinds] of Object.entries(src)) {
    if (!ACT[act]) continue;
    for (const [kind, list] of Object.entries(kinds)) {
      for (const m of list) {
        const v = attrs[byStructAttr.get(m.dogmaAttributeID)];
        if (v) mods.push([ACT[act], KIND[kind], round(-v), m.filterID || 0]);
      }
    }
  }
  if (!mods.length) continue;
  rigs[id] = {
    ...name, size: attrs[RIG_SIZE] || 0,
    fit: FIT_GROUP_ATTRS.map((a) => attrs[a]).filter(Boolean),
    sec: SEC_ATTRS.map((a) => attrs[a] ?? 1),
    m: mods
  };
}

const out = { source: "CCP SDE industryModifierSources", generatedAt: new Date().toISOString(), hulls, rigs, filters };
await writeFile(new URL("./eve-overview-clone/ind-rigs.json", import.meta.url), JSON.stringify(out));
console.log(`建筑 ${Object.keys(hulls).length} 种，改装件 ${Object.keys(rigs).length} 种，过滤器 ${Object.keys(filters).length} 个`);
