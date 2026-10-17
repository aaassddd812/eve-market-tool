// 生成 LP 商店数据 eve-overview-clone/lp-data.json
// 兑换项来自 ESI /loyalty/stores/{corporation_id}/offers/（公开接口），名称与蓝图材料来自 CCP 官方 SDE（JSONL 版）。
// 很多军团共用同一套兑换项，按 offer_id 去重后存一份。
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_lp.mjs <解压目录>             生成宁静服 lp-data.json
//      node build_lp.mjs <解压目录> --serenity 生成晨曦服 lp-data-serenity.json（兑换项取自晨曦 ESI）
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const serenity = args.includes("--serenity");
const [sdeDir] = args.filter((a) => !a.startsWith("--"));
if (!sdeDir) {
  console.error("用法: node build_lp.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

const ESI = serenity ? "https://ali-esi.evepc.163.com/latest" : "https://esi.evetech.net/latest";
const DATASOURCE = serenity ? "serenity" : "tranquility";

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

async function esi(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ESI}${path}${path.includes("?") ? "&" : "?"}datasource=${DATASOURCE}`);
    if (res.ok) return res.json();
    if (res.status === 404 || attempt >= 3) return null;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

const zh = (names) => names?.zh || names?.en || "";

const types = new Map();
await eachLine("types", (o) => types.set(o._key, o));
const groups = new Map();
await eachLine("groups", (o) => groups.set(o._key, o));
const corps = new Map();
await eachLine("npcCorporations", (o) => corps.set(o._key, o));
const factions = new Map();
await eachLine("factions", (o) => factions.set(o._key, o));
const blueprints = new Map();
await eachLine("blueprints", (o) => blueprints.set(o._key, o));

// 逐个军团读取兑换项（8 并发）
const ids = await esi("/corporations/npccorps/");
const stores = {};
const offers = {};
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < ids.length) {
    const id = ids[cursor++];
    const list = await esi(`/loyalty/stores/${id}/offers/`);
    if (!list?.length) continue;
    stores[id] = list.map((o) => o.offer_id).sort((a, b) => a - b);
    for (const o of list) {
      // [产物, 数量, LP, ISK, AK, [[材料, 数量], ...]]
      offers[o.offer_id] ??= [o.type_id, o.quantity, o.lp_cost, o.isk_cost, o.ak_cost || 0,
        (o.required_items || []).map((r) => [r.type_id, r.quantity])];
    }
  }
}));

// 蓝图拷贝：记录制造产物与材料（材料效率 0），前端按「产物价 - 材料价」估值
const bp = {};
const typeIds = new Set();
for (const [t, , , , , req] of Object.values(offers)) {
  typeIds.add(t);
  req.forEach(([r]) => typeIds.add(r));
  const m = blueprints.get(t)?.activities?.manufacturing;
  if (groups.get(types.get(t)?.groupID)?.categoryID === 9 && m?.products?.length) {
    const p = m.products[0];
    bp[t] = [p.typeID, p.quantity, (m.materials || []).map((x) => [x.typeID, x.quantity])];
    typeIds.add(p.typeID);
    m.materials?.forEach((x) => typeIds.add(x.typeID));
  }
}

const names = {};
for (const id of typeIds) names[id] = zh(types.get(id)?.name) || String(id);

const corpList = Object.keys(stores).map(Number).map((id) => {
  const c = corps.get(id);
  return { id, name: zh(c?.name) || String(id), faction: c?.factionID || null };
}).sort((a, b) => (a.faction || 9e9) - (b.faction || 9e9) || a.name.localeCompare(b.name, "zh"));

const factionNames = {};
for (const c of corpList) if (c.faction) factionNames[c.faction] = zh(factions.get(c.faction)?.name);

const out = { source: `ESI /loyalty/stores (${DATASOURCE}) + CCP SDE`, generatedAt: new Date().toISOString(), factions: factionNames, corps: corpList, stores, offers, bp, names };
const file = new URL(serenity ? "./eve-overview-clone/lp-data-serenity.json" : "./eve-overview-clone/lp-data.json", import.meta.url);
await writeFile(file, JSON.stringify(out));
console.log(`军团 ${corpList.length}，兑换项 ${Object.keys(offers).length}，蓝图 ${Object.keys(bp).length}，物品名 ${typeIds.size}`);
