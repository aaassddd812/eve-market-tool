// 从 CCP 官方 SDE（JSONL 版）生成工业建筑与改装件加成 eve-overview-clone/ind-rigs.json（制造页「我的建筑」用）
//
// ind-rigs.json：
//   hulls   建筑类型 -> { n 中文名, en 英文名, g 分组, size 改装件尺寸, b: { 活动: [ME%, TE%, 安装费%] } }
//           只收录能做工业的建筑（工程复合体、精炼厂、星城）；b 里是船体自带的减免（正数 = 减少多少 %）
//   rigs    改装件 -> { n, en, size, fit: [可装的建筑分组], sec: [高安, 低安, 00/虫洞 倍数], m: [[活动, 种类, 数值%, 过滤器]] }
//           种类 me / te / cost；数值是未乘安全等级倍数的减免 %；过滤器 0 = 不限产品
//   filters 过滤器 -> { n 名称, c: [大类], g: [分组] }（产品属于其中任一大类或分组即生效）
// 活动：m 制造、r 反应、i 发明、c 拷贝、me 材料研究、te 时间研究
// 化矿（估价页化矿设置、个人中心建筑装配）：
//   hulls[].rp  船体化矿加成 %（strRefiningYieldBonus，对提炼设施的矿石 / 卫星矿 / 冰矿化矿率按百分比加成）
//   rigs[].rp   化矿改装件 [化矿率, 'o' 矿石 'm' 卫星矿 'i' 冰矿]：把提炼设施对应类别的化矿率设为 该值 × 安全等级倍数（sec）；
//               没有改装件时提炼设施是 50%，不吃安全等级倍数
//   rpSvc       提炼设施（服务模块）类型：建筑装配里有它才能化矿
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
// 化矿：提炼设施（服务模块）上按类别的化矿率属性；改装件用 refiningYieldMultiplier 赋值给它们，船体用 strRefiningYieldBonus 百分比加成
const RP_CAT = { 2444: "o", 2445: "m", 2448: "i" };   // refiningYieldNormalOres / MoonOres / Ice
const RP_RIG_VALUE = 717;                              // refiningYieldMultiplier
const RP_HULL_BONUS = 2722;                            // strRefiningYieldBonus
const RIG_CATEGORY = 66;                               // 建筑改装件、服务模块都在「建筑装备」大类

const sources = new Map();
await eachLine("industryModifierSources", (o) => sources.set(o._key, o));
const filters = {};
await eachLine("industryTargetFilters", (o) => { filters[o._key] = { n: o.name, c: o.categoryIDs || [], g: o.groupIDs || [] }; });

const groupCat = new Map();
await eachLine("groups", (o) => groupCat.set(o._key, o.categoryID));
const types = new Map();
await eachLine("types", (o) => { if (sources.has(o._key) || HULL_GROUPS.has(o.groupID) || groupCat.get(o.groupID) === RIG_CATEGORY) types.set(o._key, o); });
const dogma = new Map();
const effectsOf = new Map();
await eachLine("typeDogma", (o) => {
  if (!types.has(o._key)) return;
  dogma.set(o._key, Object.fromEntries((o.dogmaAttributes || []).map((a) => [a.attributeID, a.value])));
  effectsOf.set(o._key, (o.dogmaEffects || []).map((e) => e.effectID));
});
const effects = new Map();
await eachLine("dogmaEffects", (o) => effects.set(o._key, o));
// 改装件改了提炼设施的哪些类别（建筑上 LocationGroupModifier，被改属性是 RP_CAT 之一，用改装件自己的 refiningYieldMultiplier 赋值）
function reprocCats(id) {
  const cats = new Set();
  for (const eid of effectsOf.get(id) || []) {
    for (const mi of effects.get(eid)?.modifierInfo || []) {
      if (mi.domain === "structureID" && RP_CAT[mi.modifiedAttributeID] && mi.modifyingAttributeID === RP_RIG_VALUE) cats.add(RP_CAT[mi.modifiedAttributeID]);
    }
  }
  return ["o", "m", "i"].filter((c) => cats.has(c)).join("");
}

const round = (v) => Math.round(v * 10000) / 10000;
const hulls = {};
const rigs = {};
const rpSvc = [];
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
    hulls[id] = { ...name, g: t.groupID, size: attrs[RIG_SIZE] || 0, b, ...(attrs[RP_HULL_BONUS] ? { rp: round(attrs[RP_HULL_BONUS]) } : {}) };
    continue;
  }
  // 提炼设施：自带三类化矿率属性的服务模块
  if (Object.keys(RP_CAT).every((a) => attrs[a] != null)) { rpSvc.push(id); continue; }
  const rpCats = attrs[RP_RIG_VALUE] && attrs[RIG_SIZE] ? reprocCats(id) : "";
  if (!src && !rpCats) continue;
  // 改装件：建筑属性（industryModifierSources 里的 dogmaAttributeID）由改装件的哪个属性修改
  const byStructAttr = new Map();
  for (const eid of effectsOf.get(id) || []) {
    for (const mi of effects.get(eid)?.modifierInfo || []) {
      if (mi.domain === "structureID" && mi.modifyingAttributeID) byStructAttr.set(mi.modifiedAttributeID, mi.modifyingAttributeID);
    }
  }
  const mods = [];
  for (const [act, kinds] of Object.entries(src || {})) {
    if (!ACT[act]) continue;
    for (const [kind, list] of Object.entries(kinds)) {
      for (const m of list) {
        const v = attrs[byStructAttr.get(m.dogmaAttributeID)];
        if (v) mods.push([ACT[act], KIND[kind], round(-v), m.filterID || 0]);
      }
    }
  }
  if (!mods.length && !rpCats) continue;
  rigs[id] = {
    ...name, size: attrs[RIG_SIZE] || 0,
    fit: FIT_GROUP_ATTRS.map((a) => attrs[a]).filter(Boolean),
    sec: SEC_ATTRS.map((a) => attrs[a] ?? 1),
    m: mods,
    ...(rpCats ? { rp: [round(attrs[RP_RIG_VALUE]), rpCats] } : {})
  };
}

const out = { source: "CCP SDE industryModifierSources", generatedAt: new Date().toISOString(), hulls, rigs, filters, rpSvc };
await writeFile(new URL("./eve-overview-clone/ind-rigs.json", import.meta.url), JSON.stringify(out));
const nRp = Object.values(rigs).filter((r) => r.rp).length;
console.log(`建筑 ${Object.keys(hulls).length} 种，改装件 ${Object.keys(rigs).length} 种（化矿 ${nRp}），过滤器 ${Object.keys(filters).length} 个，提炼设施 ${rpSvc.length} 种`);
