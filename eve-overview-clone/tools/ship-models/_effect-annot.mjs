// 调试：读 .sm_hi 效果文件，打印各阶段的纹理（是否按 sRGB 采样）和注解（node _effect-annot.mjs <文件.sm_hi>）
import { readFileSync } from 'node:fs';
await import('@carbonenginejs/runtime');
const { CjsCarbonEffectReader } = await import('./node_modules/@carbonenginejs/runtime/dist/resource/format/carbonEffect/CjsCarbonEffectReader.js');
const r = new CjsCarbonEffectReader(new Uint8Array(readFileSync(process.argv[2])));
const d = r.readDescription(0);
const nm = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
for (const t of d.techniques) for (const p of t.passes) for (const s of p.stages) {
  console.log('stage', s.type, 'textures', JSON.stringify((s.textures || []).map((x) => { const o = {}; for (const [k, v] of Object.entries(x)) o[k] = nm(v); return o; })));
}
console.log('annotations', JSON.stringify(d.annotations, (k, x) => (x instanceof Map ? Object.fromEntries(x) : x && typeof x === 'object' && 'value' in x && 'offset' in x ? x.value : x)).slice(0, 3000));
