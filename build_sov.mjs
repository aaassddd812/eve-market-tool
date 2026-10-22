// 从 CCP 官方 SDE（JSONL 版）生成主权规划数据 eve-overview-clone/sov-data.json
// 收录：全部主权中心升级件（sovereigntyUpgrades，未发布的测试 / 占位升级件不收）、两种殖民地试剂，
// 以及能建主权中心的星系（planetResources 里恒星有电力的星系）的恒星电力和各行星的殖民地资源。
//
// 输出格式（数组尽量紧凑）：
//   upgrades: [[typeID, 中文名, 英文名, 分组ID, 互斥组, 耗电, 耗劳动力, 产电, 产劳动力, 燃料typeID, 每小时燃料, 启动燃料, 说明]]
//   systems:  { 星系ID: [恒星电力, [[行星ID, 行星类型ID, 行星序号, 产量], ...]] }
//             产量：气体 / 风暴 / 等离子行星为电力，温和 / 贫瘠 / 海洋为劳动力，冰体 / 熔岩为每小时试剂（冰体超离子冰、熔岩岩浆气）
//   reagentHours: 天钩试剂仓容量折合的小时数（SDE 里所有行星都是产量 × 1460，安全仓与非安全仓相同）
//
// 用法：
//   1. 下载 https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip 并解压
//   2. node build_sov.mjs <解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_sov.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const zh = (names) => names?.zh || names?.en || "";
// 说明里的 showinfo 链接只保留文字
const plainDesc = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\r?\n+/g, " ").trim();

let sde = {};
await eachLine("_sde", (o) => { sde = o; });

const upgradesRaw = [];
await eachLine("sovereigntyUpgrades", (o) => upgradesRaw.push(o));
const wanted = new Set(upgradesRaw.map((u) => u._key));
const REAGENTS = [81143, 81144];
const types = new Map();
await eachLine("types", (o) => {
  if (wanted.has(o._key) || REAGENTS.includes(o._key) || o._key === 32458 || o._key === 81080) types.set(o._key, o);
});
const groupIds = new Set([...types.values()].map((t) => t.groupID));
const groups = {};
await eachLine("groups", (o) => { if (groupIds.has(o._key)) groups[o._key] = zh(o.name); });

const upgrades = [];
for (const u of upgradesRaw) {
  const t = types.get(u._key);
  if (!t || t.published === false) continue;
  upgrades.push([
    u._key, zh(t.name), t.name.en, t.groupID, u.mutually_exclusive_group,
    u.power_allocation || 0, u.workforce_allocation || 0, u.power_production || 0, u.workforce_production || 0,
    u.fuel?.type_id || 0, u.fuel?.hourly_upkeep || 0, u.fuel?.startup_cost || 0, plainDesc(zh(t.description))
  ]);
}
upgrades.sort((a, b) => a[3] - b[3] || a[4].localeCompare(b[4]) || a[1].localeCompare(b[1], "zh"));

const reagents = Object.fromEntries(REAGENTS.map((id) => [id, { name: zh(types.get(id).name), en: types.get(id).name.en, volume: types.get(id).volume }]));

// 恒星 → 星系、行星 → 星系 / 类型 / 序号
const starSystem = new Map();
const planets = new Map();
await eachLine("mapSolarSystems", (o) => { if (o.starID) starSystem.set(o.starID, o._key); });
await eachLine("mapPlanets", (o) => planets.set(o._key, [o.solarSystemID, o.typeID, o.celestialIndex]));

const systems = {};
const hours = new Set();
const pending = [];
await eachLine("planetResources", (o) => {
  const sys = starSystem.get(o._key);
  if (sys) { (systems[sys] ||= [0, []])[0] = o.power || 0; return; }
  pending.push(o);
});
for (const o of pending) {
  const p = planets.get(o._key);
  if (!p) continue;
  const [sys, typeID, index] = p;
  const value = o.power ?? o.workforce ?? o.reagent?.amount_per_cycle ?? 0;
  if (o.reagent) hours.add(Math.round(o.reagent.secured_capacity / o.reagent.amount_per_cycle));
  (systems[sys] ||= [0, []])[1].push([o._key, typeID, index, value]);
}
for (const s of Object.values(systems)) s[1].sort((a, b) => a[2] - b[2]);
// 只保留恒星有电力的星系（能建主权中心）
for (const [id, s] of Object.entries(systems)) if (!s[0]) delete systems[id];
if (hours.size !== 1) console.warn("注意：天钩试剂仓容量不是统一的产量倍数", [...hours]);

const out = {
  source: "CCP SDE (JSONL)",
  sdeBuild: sde.buildNumber,
  sdeDate: sde.releaseDate,
  generatedAt: new Date().toISOString(),
  hub: zh(types.get(32458)?.name), skyhook: zh(types.get(81080)?.name),
  groups, reagents, reagentHours: [...hours][0] || 0,
  upgrades, systems
};
await writeFile(new URL("./eve-overview-clone/sov-data.json", import.meta.url), JSON.stringify(out));
console.log(`升级件 ${upgrades.length} 种，星系 ${Object.keys(systems).length} 个，行星 ${Object.values(systems).reduce((n, s) => n + s[1].length, 0)} 颗（SDE ${sde.buildNumber} / ${sde.releaseDate}）`);
