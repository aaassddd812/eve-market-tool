// BC6H 立方体贴图（游戏星云 dx9/scene/universe/*_cube.dds）→ 浮点原始数据，sky.py 调用。
// 用法：node bc6h.mjs <dds> <输出文件>
// 输出：u32 边长 + 6 个面（DDS 面顺序 +X −X +Y −Y +Z −Z）各 边长² × RGBA float32，只取最大一层 mip。
// 解码器用 tools/ship-models 装的 @carbonenginejs/runtime（按 BC6H 规范解成线性 HDR 浮点，不截断到 8 位）。
import { readFileSync, writeFileSync } from 'node:fs';

const { decodeBc6h } = await import(new URL('../ship-models/node_modules/@carbonenginejs/runtime/dist/resource/formats/dds/core/bc6h.js', import.meta.url));
const [src, out] = process.argv.slice(2);
const d = readFileSync(src);
if (d.toString('latin1', 0, 4) !== 'DDS ' || d.toString('latin1', 84, 88) !== 'DX10') throw new Error('不是 DX10 头的 DDS');
const h = d.readUInt32LE(12), w = d.readUInt32LE(16), mips = Math.max(1, d.readUInt32LE(28)), fmt = d.readUInt32LE(128);
if (fmt !== 95 && fmt !== 96) throw new Error('不是 BC6H：' + fmt);
// 每个面带完整 mip 链，BC6H 每 4×4 块 16 字节
let per = 0;
for (let i = 0, mw = w, mh = h; i < mips; i++, mw = Math.max(1, mw >> 1), mh = Math.max(1, mh >> 1)) per += Math.ceil(mw / 4) * Math.ceil(mh / 4) * 16;
const head = Buffer.alloc(4);
head.writeUInt32LE(w);
const parts = [head];
for (let f = 0; f < 6; f++) {
  const off = 148 + f * per;
  const rgba = decodeBc6h(new Uint8Array(d.buffer, d.byteOffset + off, per), w, h, Math.ceil(w / 4) * 16, fmt === 96);
  parts.push(Buffer.from(rgba.buffer));
}
writeFileSync(out, Buffer.concat(parts));
