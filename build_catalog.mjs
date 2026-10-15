import { mkdir, readFile, writeFile } from "node:fs/promises";

const API = "https://esi.evetech.net/latest";
const headers = {
  "User-Agent": "EVE-Market-Tool/0.1 (local research tool)",
  "Accept-Language": "zh"
};

async function requestJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...(options.headers || {}) }
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: String(error?.message || error) };
      }
      completed += 1;
      if (onProgress && (completed % 100 === 0 || completed === items.length)) {
        onProgress(completed, items.length);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const groupIds = await requestJson(`${API}/markets/groups/`);
console.log(`Fetching ${groupIds.length} market groups...`);
const groupResults = await mapConcurrent(
  groupIds,
  24,
  (id) => requestJson(`${API}/markets/groups/${id}/?language=zh`),
  (done, total) => console.log(`groups ${done}/${total}`)
);

const groups = groupResults
  .filter((group) => group && !group.error && Number.isInteger(group.market_group_id))
  .map((group) => ({
    id: group.market_group_id,
    name: group.name,
    parentId: group.parent_group_id ?? null,
    typeIds: Array.isArray(group.types) ? group.types : []
  }));

const typeIds = [...new Set(groups.flatMap((group) => group.typeIds))];
console.log(`Resolving ${typeIds.length} item names...`);
const typeNames = new Map();
const typeCachePath = "dist/type-names-zh.json";
try {
  const cached = JSON.parse(await readFile(typeCachePath, "utf8"));
  for (const [id, name] of Object.entries(cached)) {
    if (name) typeNames.set(Number(id), name);
  }
  console.log(`Loaded ${typeNames.size} cached Chinese type names`);
} catch {
  // The cache is optional; missing or invalid cache is rebuilt below.
}

const missingTypeIds = typeIds.filter((id) => !typeNames.has(id));
const typeResults = await mapConcurrent(
  missingTypeIds,
  16,
  async (id) => {
    const type = await requestJson(`${API}/universe/types/${id}/?language=zh`);
    return { id, name: type?.name || "" };
  },
  (done, total) => console.log(`types ${done}/${total}`)
);
for (const result of typeResults) {
  if (result && !result.error && result.name) typeNames.set(result.id, result.name);
}
await mkdir("dist", { recursive: true });
await writeFile(typeCachePath, JSON.stringify(Object.fromEntries(typeNames)));

const catalog = {
  source: "EVE ESI markets/groups + universe/types?language=zh",
  generatedAt: new Date().toISOString(),
  groups: groups
    .map((group) => ({
      id: group.id,
      name: group.name || `市场组 ${group.id}`,
      parentId: group.parentId,
      types: group.typeIds
        .map((id) => ({ id, name: typeNames.get(id) || `物品 ${id}` }))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
};

await mkdir("dist", { recursive: true });
await writeFile("dist/catalog.json", JSON.stringify(catalog));
console.log(`Wrote dist/catalog.json (${catalog.groups.length} groups, ${typeIds.length} types)`);
