// 驾驶模拟场景用的 NPC 数据：从 SDE（JSON Lines 目录）抽出 js/pilot-sites.js 里用到的 NPC、建筑、导弹和地下城说明 → npc-data.json
// 用法：node tools/build-npc-data.mjs <SDE 目录> [输出，默认 npc-data.json]
// 输出：{ build, npc: { typeID: { n: [中文, 英文], g: 组, gn: [组名中, 英], r: 半径, m: 质量, gfx: graphicID, a: { 属性: 值 }, e: [效果名] } },
//        msl: { 导弹 typeID: { n, a } }, dun: { 地下城 ID: { n: [中, 英], d: [中, 英] } } }
// 属性全收（NPC 不多），只去掉 AI_ 开头、掉落 / 声望这些模拟用不到的
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDE = resolve(process.argv[2] || join(HERE, '../../../sde'));
const OUT = resolve(process.argv[3] || join(HERE, '../npc-data.json'));
const jsonl = (f) => readFileSync(join(SDE, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const { SITES } = await import(pathToFileURL(join(HERE, '../js/pilot-sites.js')).href);

const want = new Set(), dun = new Set();
for (const s of SITES) {
  if (s.dungeon) dun.add(s.dungeon);
  // 深渊按等级的场景：刷怪池、气云 / 塔候选、导管和蛋（房间在运行时随机生成）
  for (const sp of s.pool || []) {
    for (const [, , ids] of sp.g || []) for (const t of ids) want.add(t);
    for (const pt of sp.parts || []) for (const [t] of pt.g) want.add(t);   // T6 实测统计的房间
  }
  for (const t of Object.keys(s.objs || {})) want.add(Number(t));
  if (s.pool) for (const t of [47685, 47686, 47951]) want.add(t);
  for (const r of s.rooms) {
    for (const o of r.objs || []) if (o.type) want.add(o.type);
    for (const w of r.waves || []) for (const [t] of w.npcs) want.add(t);
  }
}
const attrs = new Map(jsonl('dogmaAttributes.jsonl').map((a) => [a._key, a.name]));
const effs = new Map(jsonl('dogmaEffects.jsonl').map((e) => [e._key, e.name]));
const groups = new Map(jsonl('groups.jsonl').map((g) => [g._key, g]));
const types = new Map(jsonl('types.jsonl').map((t) => [t._key, t]));
const dogma = new Map(jsonl('typeDogma.jsonl').map((d) => [d._key, d]));
const SKIP = /^(AI_|entityLoot|entitySecurity|entityFaction|entityBracket|entityOverview|gfx|propulsionGraphic|entityGroupRespawn|disallowAssistance)/;
const name = (t) => [t.name?.zh || t.name?.en || '', t.name?.en || ''];
const attrsOf = (id, all = false) => Object.fromEntries((dogma.get(id)?.dogmaAttributes || []).filter((a) => all || !SKIP.test(attrs.get(a.attributeID) || '')).map((a) => [a.attributeID, +a.value.toPrecision(6)]));
const out = { build: JSON.parse(readFileSync(join(SDE, '_sde.jsonl'), 'utf8')).buildNumber, npc: {}, msl: {}, dun: {} };
const miss = [];
for (const id of [...want].sort((a, b) => a - b)) {
  const t = types.get(id);
  if (!t) { miss.push(id); continue; }
  const g = groups.get(t.groupID);
  const a = attrsOf(id);
  out.npc[id] = { n: name(t), g: t.groupID, gn: name(g || {}), r: t.radius || 0, m: t.mass || 0, gfx: t.graphicID || 0, a,
    e: (dogma.get(id)?.dogmaEffects || []).map((e) => effs.get(e.effectID)).filter(Boolean) };
  const mid = a[507];
  if (mid && types.has(mid) && !out.msl[mid]) out.msl[mid] = { n: name(types.get(mid)), a: attrsOf(mid, true) };
}
const D = new Map(jsonl('dungeons.jsonl').map((d) => [d._key, d]));
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
for (const id of dun) {
  const d = D.get(id);
  if (d) out.dun[id] = { n: [d.name?.zh || d.name?.en || '', d.name?.en || ''], d: [strip(d.description?.zh || d.description?.en), strip(d.description?.en)] };
  else miss.push('dungeon ' + id);
}
writeFileSync(OUT, JSON.stringify(out));
console.log('NPC', Object.keys(out.npc).length, '导弹', Object.keys(out.msl).length, '地下城', Object.keys(out.dun).length, miss.length ? '缺 ' + miss.join(',') : '');
