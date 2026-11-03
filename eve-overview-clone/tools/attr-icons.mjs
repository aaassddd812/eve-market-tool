// 装配属性图标：EVE 客户端资源服务器 → assets/attr/<名>.png（装配页右侧属性面板用）
//
// 用法：node tools/attr-icons.mjs
// 图标路径取自 SDE（dogmaAttributes.iconID → icons.iconFile），下面按用途列出；资源索引同 tools/ship-models/convert.mjs。
// 图标版权归 CCP。
import { writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/attr');
const BIN = 'https://binaries.eveonline.com/';
const RES = 'https://resources.eveonline.com/';
const ICONS = {
  shield: '22_32_7', armor: '22_32_6', hull: '2_64_9', repair: '1_64_11', recharge: '22_32_16',
  em: '22_32_12', th: '22_32_10', ki: '22_32_9', ex: '22_32_11',
  cap: '1_64_5', cpu: '12_64_7', power: '2_64_7', calibration: '55_64_13',
  turret: '12_64_9', launcher: '12_64_12', drone: '11_64_16', bandwidth: '56_64_5', fighter: '49_64_7',
  damage: '26_64_1', rof: '22_32_21',
  velocity: '22_32_13', agility: '22_32_24', warp: '76_64_16', sig: '22_32_14', mass: '2_64_10',
  range: '22_32_15', scanres: '3_64_9', targets: '4_64_12', cargo: '3_64_13',
  radar: '22_32_28', ladar: '22_32_27', magnet: '22_32_26', gravi: '22_32_25',
  mining: '6_64_14', waste: '62_64_13'
};

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
}

const build = JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
const index = new Map();
for (const [, path] of app.split('\n').map((l) => l.split(',')).filter((p) => p[0] === 'app:/resfileindex.txt')) {
  for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) {
    const p = l.split(',');
    if (p[1]) index.set(p[0].toLowerCase(), p[1]);
  }
}
mkdirSync(OUT, { recursive: true });
for (const [name, file] of Object.entries(ICONS)) {
  const res = `res:/ui/texture/icons/${file}.png`;
  if (!index.has(res)) { console.log('没有', name, res); continue; }
  writeFileSync(join(OUT, name + '.png'), await fetchBuf(RES + index.get(res)));
  console.log(name, res);
}
console.log('客户端版本', build);
