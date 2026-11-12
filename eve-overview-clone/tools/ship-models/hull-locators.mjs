// 读船体 .black 里的定位点（受损火焰 vds_trail、受击点 damage）。
// 单独一个进程：convert.mjs 里加载的 SOF 模块会登记一份旧的类定义，读不了新版船体文件；这里只加载通用解析器。
// 输入（stdin）：{ 船体名: 本地 .black 文件路径 }；输出（stdout）：{ 船体名: { vds_trail: [[x,y,z],…], damage: [[x,y,z],…], turrets: [['1a', 矩阵],…] } }
import { readFileSync } from 'node:fs';

await import('@carbonenginejs/runtime');
const { CjsBlackFormat } = await import('@carbonenginejs/runtime/resource/formats/black');
const jobs = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
for (const [hull, file] of Object.entries(jobs)) {
  try {
    const hb = await CjsBlackFormat.read(new Uint8Array(readFileSync(file)));
    const got = {};
    for (const ls of hb.object?.locatorSets || []) {
      if (ls.name !== 'vds_trail' && ls.name !== 'damage') continue;
      got[ls.name] = (ls.locators || []).map((l) => Array.from(l.position || [0, 0, 0]).map((x) => +(+x).toFixed(1)));
    }
    // 炮塔挂点（客户端 TurretSet：高槽 N 的炮挂到名字以 locator_turret_N 开头的每个挂点上，a / b / c 都挂）：[名字后缀, 4×4 矩阵（含朝向与缩放）]
    const lt = (hb.object?.locatorTurrets || []).filter((l) => /^locator_turret_\d/.test(l.name || ''));
    if (lt.length) got.turrets = lt.map((l) => [l.name.slice(15), Array.from(l.transform || []).map((x) => +(+x).toFixed(4))]);
    out[hull] = got;
  } catch (e) {
    process.stderr.write(`${hull}: ${e.message}\n`);
  }
}
process.stdout.write(JSON.stringify(out));
