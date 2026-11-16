// 生成物品商人（Item Trader）兑换数据 eve-overview-clone/item-trader.json（LP 商店页「物品商人」用）
// 活动代币（血色收割的变异血液样本、帝国战役凭证等）在太空里的物品商人处兑换，ESI 没有这份列表；
// 兑换配方在客户端静态数据 res:/staticdata/itemtraderrecipes.fsdbinary 里，从 CCP 公开资源服务器下载解析
// （binaries.eveonline.com 取当前客户端版本 → resfileindex → resources.eveonline.com，与 tools/attr-icons.mjs 相同）。
// 表里是全部配方（含已结束活动的），哪个商人当前开放哪些配方由服务器下发，客户端数据里没有。
//
// item-trader.json：
//   build     客户端版本
//   recipes   [[配方 ID, 分组, ISK, [[输入物品, 数量], ...], [[输出物品, 数量], ...]], ...]
//             分组是客户端物品商人窗口的分组（SKINS / SKINR / BOOSTERS / MUTAPLASMIDS / SHIP_BLUEPRINTS / MODULES_AMMO …，空 = 其他）
//             去掉了输入或输出含未发布物品的配方（过期增效剂等旧活动）和占位配方
//   names     物品中文名
//   tokens    代币（作为输入出现的物品）-> [市场分组名, 中文说明, 英文说明]；说明里星系链接写成 [[sys:星系ID|名称]]，其余标签去掉
//
// 文件格式（fsdbinary，gzip 压缩）：前 24 字节是校验，之后的偏移都相对第 24 字节；
//   根是按 键 mod 桶数 分桶的哈希表：[桶数, 各桶偏移...]，桶 = [条数, 条目...]；
//   配方条目 9 个 u64：ID、分组（字符串偏移）、输入（字典偏移）、输入种数、内部名（字符串偏移）、输出（字典偏移）、输出种数、
//   低 32 位 displayNameID + 高 32 位 ISK、未知整数；字典同样分桶，条目是 u32 物品 + u32 数量；字符串 = [长度, UTF-8]
//
// 用法：node build_item_trader.mjs <SDE JSONL 解压目录>
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";

const [, , sdeDir] = process.argv;
if (!sdeDir) {
  console.error("用法: node build_item_trader.mjs <SDE JSONL 解压目录>");
  process.exit(1);
}

const BIN = "https://binaries.eveonline.com/";
const RES = "https://resources.eveonline.com/";
const FILE = "res:/staticdata/itemtraderrecipes.fsdbinary";

async function fetchBuf(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const b = Buffer.from(await r.arrayBuffer());
      return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function eachLine(name, fn) {
  const rl = createInterface({ input: createReadStream(`${sdeDir}/${name}.jsonl`, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

// ---------- 下载 ----------
const build = JSON.parse((await fetchBuf(BIN + "eveclient_TQ.json")).toString()).build;
const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
const idxPath = app.split("\n").map((l) => l.split(",")).find((p) => p[0] === "app:/resfileindex.txt")?.[1];
if (!idxPath) throw new Error("客户端文件列表里没有 resfileindex");
const resPath = (await fetchBuf(BIN + idxPath)).toString().split("\n").map((l) => l.split(",")).find((p) => p[0].toLowerCase() === FILE)?.[1];
if (!resPath) throw new Error("资源索引里没有 " + FILE);
const buf = await fetchBuf(RES + resPath);

// ---------- 解析 ----------
const B = 24;
const u64 = (o) => {
  const v = buf.readBigUInt64LE(o);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`偏移 ${o} 的值过大，文件格式可能变了`);
  return Number(v);
};
const at = (p) => {
  const o = p + B;
  if (o < B || o + 8 > buf.length) throw new Error(`偏移越界 ${p}，文件格式可能变了`);
  return o;
};
const str = (p) => { const o = at(p), n = u64(o); return buf.toString("utf8", o + 8, o + 8 + n); };
function buckets(p, size, fn) {
  const o = at(p), nb = u64(o);
  if (nb > 100000) throw new Error("桶数异常，文件格式可能变了");
  for (let i = 0; i < nb; i++) {
    const b = at(u64(o + 8 + 8 * i)), cnt = u64(b);
    if (cnt > 100000) throw new Error("条数异常，文件格式可能变了");
    for (let j = 0; j < cnt; j++) fn(b + 8 + size * j);
  }
}
const dict = (p) => {
  const out = [];
  buckets(p, 8, (e) => out.push([buf.readUInt32LE(e), buf.readUInt32LE(e + 4)]));
  return out.sort((a, b) => a[0] - b[0]);
};
const total = u64(B + 16);
const raw = [];
buckets(u64(B + 8), 72, (e) => {
  const w = Array.from({ length: 9 }, (_, k) => buf.readBigUInt64LE(e + 8 * k));
  const ins = dict(Number(w[2])), outs = dict(Number(w[5]));
  if (ins.length !== Number(w[3]) || outs.length !== Number(w[6])) throw new Error(`配方 ${w[0]} 物品数对不上，文件格式可能变了`);
  raw.push({ id: Number(w[0]), group: str(Number(w[1])), name: str(Number(w[4])), isk: Number(w[7] >> 32n), ins, outs });
});
if (raw.length !== total || !raw.length) throw new Error(`配方数 ${raw.length} 与文件头 ${total} 不符，文件格式可能变了`);

// ---------- SDE ----------
const types = new Map();
await eachLine("types", (o) => types.set(o._key, o));
const marketGroups = new Map();
await eachLine("marketGroups", (o) => marketGroups.set(o._key, o));
const zh = (n) => n?.zh || n?.en || "";
const ok = (id) => types.get(id)?.published;

const PLACEHOLDER = /placeholder/i;
const recipes = raw
  .filter((r) => !PLACEHOLDER.test(r.name) && r.ins.length && r.outs.length && [...r.ins, ...r.outs].every(([t]) => ok(t)))
  .sort((a, b) => a.id - b.id);

// 说明文字：星系链接保留成 [[sys:ID|名称]]（页面上链到星图），其余标签去掉
const desc = (s) => (s || "")
  .replace(/<url=showinfo:5\/\/(\d+)>([^<]*)<\/url>/gi, (_, id, name) => `[[sys:${id}|${name.replace(/[[\]|]/g, "")}]]`)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/\r/g, "")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const names = {};
const tokens = {};
for (const r of recipes) {
  for (const [t] of [...r.ins, ...r.outs]) names[t] ??= zh(types.get(t).name);
  for (const [t] of r.ins) {
    if (tokens[t]) continue;
    const o = types.get(t);
    tokens[t] = [zh(marketGroups.get(o.marketGroupID)?.name), desc(o.description?.zh), desc(o.description?.en)];
  }
}

const out = {
  source: `EVE 客户端 ${FILE}（build ${build}）+ CCP SDE`,
  generatedAt: new Date().toISOString(),
  build,
  recipes: recipes.map((r) => [r.id, r.group, r.isk, r.ins, r.outs]),
  names,
  tokens
};
await writeFile(new URL("./eve-overview-clone/item-trader.json", import.meta.url), JSON.stringify(out));
console.log(`客户端 ${build}：配方 ${raw.length} 条，保留 ${recipes.length} 条，代币 ${Object.keys(tokens).length} 种`);
