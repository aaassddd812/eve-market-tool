// 读炮塔 .black（EveTurretSet）。和 hull-locators.mjs 一样单独一个进程：convert.mjs 里的 SOF 模块会占住类定义，读不了 Tr2Effect。
// 输入（stdin）：{ res 路径: 本地文件 }；输出（stdout）：{ res 路径: { type, geometryResPath, boundingSphere, effect: { effectFilePath, constParameters, resources }, … } }
import { readFileSync } from 'node:fs';

await import('@carbonenginejs/runtime');
const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');
const jobs = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
const arr = (v) => Array.from(v || []).map((x) => +x);
for (const [path, file] of Object.entries(jobs)) {
  try {
    const o = (await CjsBlackFormat.read(new Uint8Array(readFileSync(file)))).object || {};
    const e = o.turretEffect || {};
    out[path] = {
      type: o._type, geometryResPath: o.geometryResPath || '', boundingSphere: arr(o.boundingSphere),
      sysBonePitchMin: +o.sysBonePitchMin || 0, bottomClipHeight: +o.bottomClipHeight || 0, firingEffectResPath: o.firingEffectResPath || '',
      effect: { effectFilePath: e.effectFilePath || '', constParameters: (e.constParameters || []).map((p) => ({ name: p.name, value: arr(p.value) })), resources: (e.resources || []).map((r) => ({ name: r.name, resourcePath: r.resourcePath })) },
    };
  } catch (err) {
    process.stderr.write(`${path}: ${err.message}\n`);
  }
}
process.stdout.write(JSON.stringify(out));
